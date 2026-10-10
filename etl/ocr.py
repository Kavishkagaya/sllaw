#!/usr/bin/env python3
"""Step 2b: OCR scanned pages with LightOnOCR-3-0.8B (decision 2026-10-09; see PIPELINE.md).

  python3 -m etl.ocr --count                                 # files and pages to do
  python3 -m etl.ocr --api http://localhost:8012/v1 --shard 0/4
  python3 -m etl.ocr --retry-cut                             # pages that ran into max_tokens
  (one process per shard; two per vLLM server, each server on its own card)

Queue: English files dated before --before (default 2000) whose raw/v2 has scanned pages (an image
and no text layer, or someone else's OCR layer; same test as extract.is_scan), and no
raw/lighton/<sha256>.json.gz yet. Each page is rendered at 400 DPI, shrunk to 2048 px on its longest
side (model card) and sent with the `grounding` prompt. Writes raw/lighton/<sha256>.json.gz =
{sha256, model, params, pages: [{page_no, md, tokens, finish}]}, only when every page came back;
raw/v2 stays as it is. etl.structure.blocks() reads these pages in place of Chandra's / Surya's,
only those with finish "stop"; for the others it keeps the old engine's page.

Runaway pages (2026-10-09: 82 of 8,861 ran into 8,192 tokens): Appropriation tables looping on empty
<th></th> cells, a stamp ("5 0 5 0"), dot leaders, an upside-down block, "(1) (1)". --retry-cut asks
again with RETRIES in order and keeps the first answer that stops; none of the four settings worked on
all seven test pages, frequency_penalty cut tables short. Sinhala/Tamil pages in files listed as English
(the 0.8B has no Sinhala: it writes Telugu-like loops) are marked finish "not_english", not retried.
"""
import argparse, base64, gzip, io, json, os, re, threading, time
from concurrent.futures import ThreadPoolExecutor

import psycopg2, pypdfium2, requests
from dotenv import load_dotenv

from etl.fetch import r2

MODEL = "lightonai/LightOnOCR-3-0.8B"
PARAMS = {"prompt": "grounding", "dpi": 400, "max_side": 2048, "temperature": 0.2, "top_p": 0.9}
RETRIES = [("repetition_penalty 1.05", {"repetition_penalty": 1.05}), ("temperature 0.7", {"temperature": 0.7}),
           ("repetition_penalty 1.15", {"repetition_penalty": 1.15})]
_render = threading.Lock()     # pdfium is not thread-safe


def scan_pages(raw):
    return [p["page_no"] for p in raw.get("pages") or []
            if p.get("images") and (p["chars"] < 20 or p.get("ocr_layer"))]


def render(pdf, page_no):
    with _render:
        im = pdf[page_no - 1].render(scale=PARAMS["dpi"] / 72).to_pil()
    im.thumbnail((PARAMS["max_side"], PARAMS["max_side"]))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def ocr(api, png_b64, max_tokens, extra=None):
    """One page -> (markdown, new tokens, finish reason). extra: more sampling fields (retries)."""
    content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + png_b64}},
               {"type": "text", "text": PARAMS["prompt"]}]
    for attempt in range(3):
        try:
            r = requests.post(f"{api}/chat/completions", timeout=900, json={
                "model": "lighton", "messages": [{"role": "user", "content": content}], "max_tokens": max_tokens,
                "temperature": PARAMS["temperature"], "top_p": PARAMS["top_p"], **(extra or {})})
            r.raise_for_status()
            j = r.json()
            return j["choices"][0]["message"]["content"], j["usage"]["completion_tokens"], j["choices"][0]["finish_reason"]
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(10)


def not_english(md):
    return len(re.findall(r'[^\x00-\x7F\u2018-\u201d\u2013\u2014\u2026]', md)) > len(re.findall(r'[A-Za-z]', md))


def retry_cut(api, s3, bucket, keys):
    """Re-ask the pages that ran into max_tokens, with RETRIES in order; rewrites raw/lighton objects."""
    load = lambda k: json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=k)["Body"].read()))
    conn = psycopg2.connect(os.environ["DATABASE_URL"])

    def one(k):
        j = load(k)
        cut = [p for p in j["pages"] if p["finish"] == "length"]
        if not cut:
            return
        with conn.cursor() as cur:
            cur.execute("SELECT r2_key FROM documents WHERE sha256 = %s LIMIT 1", (j["sha256"],))
            pdf = pypdfium2.PdfDocument(s3.get_object(Bucket=bucket, Key=cur.fetchone()[0])["Body"].read())
        for p in cut:
            if not_english(p["md"]):
                p["finish"] = "not_english"
                continue
            png = render(pdf, p["page_no"])
            for name, extra in RETRIES:
                md, tok, fin = ocr(api, png, j["params"]["max_tokens"], extra)
                if fin == "stop":
                    p.update(md=md, tokens=tok, finish=fin, retry=name)
                    break
        j["params"]["retries"] = [n for n, _ in RETRIES]
        s3.put_object(Bucket=bucket, Key=k, ContentType="application/gzip",
                      Body=gzip.compress(json.dumps(j, ensure_ascii=False).encode()))
        print(f"{j['sha256'][:12]}: " + ", ".join(f"p{p['page_no']} {p['finish']}{' (' + p['retry'] + ')' if p.get('retry') else ''}"
                                                   for p in cut), flush=True)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(one, sorted(keys)))
    conn.close()


def queue(before, shard):
    i, n = map(int, shard.split("/"))
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        cur.execute("""SELECT DISTINCT ON (sha256) sha256, r2_key, raw_key FROM documents
                       WHERE raw_key IS NOT NULL AND r2_key LIKE '%%.pdf' AND meta->>'lang' = 'ENGLISH'
                         AND source <> 'le1980' AND doc_date < %s ORDER BY sha256""", (before,))
        rows = [r for r in cur.fetchall() if int(r[0], 16) % n == i]
    conn.close()
    return rows


def done_keys(s3, bucket):
    keys = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="raw/lighton/"):
        keys |= {o["Key"].split("/")[-1].split(".")[0] for o in page.get("Contents", [])}
    return keys


def main():
    load_dotenv()
    a = argparse.ArgumentParser()
    a.add_argument("--api", default="http://localhost:8012/v1")
    a.add_argument("--shard", default="0/1", help="i/n: this process takes files with sha256 %% n == i")
    a.add_argument("--before", default="2000")
    a.add_argument("--pages", type=int, default=24, help="pages in flight to the server")
    a.add_argument("--files", type=int, default=6, help="files in progress at once")
    a.add_argument("--max-tokens", type=int, default=8192, help="Appropriation tables run past 4096 (61/1993)")
    a.add_argument("--retry-cut", action="store_true", help="re-ask pages that ran into max_tokens (RETRIES)")
    a.add_argument("--count", action="store_true", help="only count files and scanned pages left to do")
    args = a.parse_args()
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    done = done_keys(s3, bucket)
    if args.retry_cut:
        return retry_cut(args.api, s3, bucket, [f"raw/lighton/{sha}.json.gz" for sha in done])
    rows = [r for r in queue(args.before, args.shard) if r[0] not in done]
    load = lambda k: json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=k)["Body"].read()))
    if args.count:
        with ThreadPoolExecutor(16) as ex:
            n = list(ex.map(lambda r: len(scan_pages(load(r[2]))), rows))
        print(f"{len(rows)} files left (shard {args.shard}, before {args.before}), "
              f"{sum(x > 0 for x in n)} with scanned pages, {sum(n)} scanned pages")
        return
    pages_ex = ThreadPoolExecutor(args.pages)
    t_start, stats = time.time(), {"pages": 0, "ok": 0, "bad": 0}
    lock = threading.Lock()

    def one(job):
        i, (sha, key, rkey) = job
        t0 = time.time()
        try:
            want = scan_pages(load(rkey))
            if not want:
                return
            pdf = pypdfium2.PdfDocument(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
            futs = [pages_ex.submit(lambda n: ocr(args.api, render(pdf, n), args.max_tokens), n) for n in want]
            res = [f.result() for f in futs]
            out = {"sha256": sha, "model": MODEL, "params": {**PARAMS, "max_tokens": args.max_tokens},
                   "pages": [{"page_no": n, "md": md, "tokens": t, "finish": fin} for n, (md, t, fin) in zip(want, res)]}
            s3.put_object(Bucket=bucket, Key=f"raw/lighton/{sha}.json.gz", ContentType="application/gzip",
                          Body=gzip.compress(json.dumps(out, ensure_ascii=False).encode()))
            cut = sum(fin != "stop" for _, _, fin in res)
            with lock:
                stats["ok"] += 1
                stats["pages"] += len(want)
                rate = stats["pages"] / (time.time() - t_start)
            print(f"[{i}/{len(rows)}] {sha[:12]}: {len(want)} pages in {time.time() - t0:.0f}s"
                  f"{f', {cut} cut off' if cut else ''} | {rate:.2f} pages/s overall", flush=True)
        except Exception as e:          # the file stays queued: no raw/lighton object is written
            with lock:
                stats["bad"] += 1
            print(f"[{i}/{len(rows)}] {sha[:12]}: FAIL {e}"[:200], flush=True)

    # several files at once, so short Acts (3-5 pages) still keep the server's batch full
    with ThreadPoolExecutor(args.files) as ex:
        list(ex.map(one, enumerate(rows, 1)))
    print(f"\n{stats['ok']} files written, {stats['bad']} failed (failed ones stay queued; re-run to retry)")


if __name__ == "__main__":
    main()
