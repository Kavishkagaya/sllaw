"""Experiment: LightOnOCR-3 (grounding mode, served by vLLM) against the Chandra raws of scanned Acts.

    python -m etl.ocr_lighton --n 8 --years 1990-1999 --api http://localhost:8012/v1
    python -m etl.ocr_lighton --acts 20/1997,48/1984   # named Acts, against their stored raw (Chandra or Surya)
    python -m etl.ocr_lighton --le1980 --n 8          # two-column 1980 chapters, against their text layer

with the model served by vLLM (transformers' fallback kernels for Qwen3.5 ran at ~2 tokens/s, 2026-10-09):
    vllm serve /var/tmp/e19309/models/LightOnOCR-3-0.8B --served-model-name lighton --port 8012 \
        --default-chat-template-kwargs '{"enable_thinking": false}' --gpu-memory-utilization 0.25

Picks the smallest English Acts of those years whose raw has Chandra pages, renders each of those
pages (400 DPI, longest side 2048 px, as the model card says), asks the model with the `grounding`
prompt, and rewrites its blocks (`![label](x0,y0,x1,y1)` + markdown, 0-1000 grid) as Chandra-style
`<div data-bbox data-label>` HTML, so etl.structure reads both the same way. Prints, per Act, both
engines' sections / notes / warnings and the share of words found in /usr/share/dict/words, and
writes both texts per page to --out for reading side by side. Nothing is written to R2 or Neon.
"""
import argparse, base64, gzip, html, io, json, os, re, sys, time
from pathlib import Path

import psycopg2, pypdfium2, requests
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv

from etl.fetch import r2
from difflib import SequenceMatcher

from etl.structure import LIGHTON_BLOCK as BLOCK, act, blocks, html_text, le1980_blocks, lighton_html as to_html

WORDS = {w.strip().lower() for w in open("/usr/share/dict/words") if w.strip().isalpha()}


def ocr(api, img, max_tokens):
    """One page -> (markdown, new tokens, finish reason)."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}},
               {"type": "text", "text": "grounding"}]
    r = requests.post(f"{api}/chat/completions", timeout=900, json={
        "model": "lighton", "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens, "temperature": 0.2, "top_p": 0.9})
    r.raise_for_status()
    j = r.json()
    return j["choices"][0]["message"]["content"], j["usage"]["completion_tokens"], j["choices"][0]["finish_reason"]


def word_rate(text):
    ws = [w.lower() for w in re.findall(r"[A-Za-z]{3,}", text)]
    return sum(w in WORDS for w in ws) / max(len(ws), 1), len(ws)


def summary(doc):
    return {"sections": len(doc["sections"]), "notes": sum(1 for s in doc["sections"] if s["note"]),
            "warnings": len(doc["warnings"]), "nums": [s["num"] for s in doc["sections"]]}


def candidates(years, acts=None):
    """Smallest English Act files of those years, or the files of these Acts ("20/1997,48/1984")."""
    y0, y1 = years.split("-")
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        if acts:
            cur.execute("""SELECT d.sha256, d.r2_key, d.raw_key, a.key, d.doc_date, d.bytes FROM acts a
                           JOIN documents d ON d.id = a.document_id WHERE a.key = ANY(%s)""",
                        (["act:" + x for x in acts.split(",")],))
        else:
            cur.execute("""SELECT DISTINCT ON (sha256) sha256, r2_key, raw_key, title, doc_date, bytes FROM documents
                           WHERE raw_key IS NOT NULL AND r2_key LIKE '%%.pdf' AND meta->>'lang' = 'ENGLISH'
                             AND doc_date >= %s AND doc_date < %s""", (y0, str(int(y1) + 1)))
        rows = sorted(cur.fetchall(), key=lambda r: r[5])
    conn.close()
    return rows


def norm(t):
    return re.sub(r'[^a-z0-9]+', ' ', t.lower()).strip()


def le1980(args, s3, bucket, out):
    """The two-column 1980 chapters: LightOn's text, in its own reading order, against le1980_blocks()
    from the text layer (body: left column then right; margin: the notes). Per chapter: word-sequence
    similarity of the body, section numbers found, notes found verbatim (normalised)."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        cur.execute("""SELECT sha256, r2_key, raw_key, title, meta->>'cap', bytes FROM documents
                       WHERE source = 'le1980' AND raw_key IS NOT NULL ORDER BY bytes""")
        rows = cur.fetchall()
    conn.close()
    done, report = 0, []
    for sha, key, rkey, title, cap, size in rows:
        if done >= args.n:
            break
        raw = json.load(gzip.open(io.BytesIO(s3.get_object(Bucket=bucket, Key=rkey)["Body"].read())))
        pages = sorted(p["page_no"] for p in raw["docling"]["pages"])
        if len(pages) < args.min_pages:
            continue
        pages = pages[:args.max_pages]
        ref = [b for b in le1980_blocks(raw) if b["page"] in pages]
        pdf = pypdfium2.PdfDocument(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
        imgs = []
        for n in pages:
            im = pdf[n - 1].render(scale=400 / 72).to_pil()
            im.thumbnail((2048, 2048))
            imgs.append(im)
        t0 = time.time()
        with ThreadPoolExecutor(16) as ex:
            res = list(ex.map(lambda im: ocr(args.api, im, args.max_tokens), imgs))
        secs = time.time() - t0
        md = "\n".join(m for m, _, _ in res)
        body = [BLOCK.sub("", x) for x in re.split(r'(?=^!\[)', md, flags=re.M)
                if not re.match(r'^!\[(header|footer|page_number)', x)]
        lo_words = norm(re.sub(r'\*[A-Z][^*]{2,}\*?', ' ', " ".join(body))).split()   # notes out
        ref_words = norm(" ".join(b["text"] for b in ref if b["role"] == "body")).split()
        sim = SequenceMatcher(None, ref_words, lo_words, autojunk=False).ratio()
        lo_flat = " " + norm(md) + " "
        notes = [norm(b["text"]) for b in ref if b["role"] == "margin" and len(norm(b["text"])) > 3]
        nums = re.findall(r'(?:^|\n)\s*(\d{1,3}[A-Z]?)\.\s', "\n".join(body))
        ref_nums = [m[1] for b in ref if b["role"] == "body" and (m := re.match(r'(\d{1,3}[A-Z]?)\s*\.\s', b["text"]))]
        r = {"sha256": sha, "cap": cap, "title": title, "pages": len(imgs), "secs": round(secs, 1),
             "truncated": sum(f != "stop" for _, _, f in res), "body_similarity": round(sim, 3),
             "notes_found": f"{sum(f' {x} ' in lo_flat for x in notes)}/{len(notes)}",
             "sections_found": f"{len(set(ref_nums) & set(nums))}/{len(set(ref_nums))}",
             "dict_words": [round(word_rate(" ".join(b["text"] for b in ref))[0], 3), round(word_rate(md)[0], 3)]}
        with open(out / f"le1980_cap{cap}.txt", "w") as f:
            for n, (m, _, fin) in zip(pages, res):
                f.write(f"===== page {n} TEXT LAYER (le1980_blocks)\n" + "\n".join(
                    f"[{b['role']}] {b['text']}" for b in ref if b["page"] == n) + f"\n===== page {n} LIGHTON ({fin})\n{m}\n\n")
        report.append(r)
        done += 1
        print(json.dumps(r, ensure_ascii=False), flush=True)
    (out / "report_le1980.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))


def main():
    load_dotenv()
    a = argparse.ArgumentParser()
    a.add_argument("--n", type=int, default=8)
    a.add_argument("--years", default="1990-1999")
    a.add_argument("--min-pages", type=int, default=3, help="skip one- and two-page files (covers, noise)")
    a.add_argument("--api", default="http://localhost:8012/v1")
    a.add_argument("--name", default="LightOnOCR-3-0.8B", help="output subdirectory")
    a.add_argument("--max-tokens", type=int, default=4096)
    a.add_argument("--out", default=os.path.expanduser("~/sllaw/logs/lighton"))
    a.add_argument("--acts", help="these Acts instead, e.g. 20/1997,48/1984 (stored raw from Chandra or Surya)")
    a.add_argument("--le1980", action="store_true", help="the two-column 1980 chapters, against their text layer")
    a.add_argument("--max-pages", type=int, default=6, help="le1980: first pages of each chapter only")
    args = a.parse_args()
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    out = Path(args.out, args.name)
    out.mkdir(parents=True, exist_ok=True)
    if args.le1980:
        return le1980(args, s3, bucket, out)
    done, report = 0, []
    for sha, key, rkey, title, date, size in candidates(args.years, args.acts):
        if done >= args.n and not args.acts:
            break
        raw = json.load(gzip.open(io.BytesIO(s3.get_object(Bucket=bucket, Key=rkey)["Body"].read())))
        ch = raw.get("chandra")
        if ch and ch.get("pages"):
            engine = "chandra"
        elif args.acts:     # Surya inside docling (since 2026-10-06): its scan pages, the ones with no text layer
            engine, ch = "surya", {"params": {}, "pages": [{"page_no": p["page_no"], "raw": ""}
                                                           for p in raw["pages"] if p.get("chars", 1) == 0]}
            if not ch["pages"]:
                print(f"{title}: no scanned pages, skipped", flush=True)
                continue
        else:
            continue
        if len(ch["pages"]) < args.min_pages and not args.acts:
            continue
        pdf = pypdfium2.PdfDocument(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
        imgs = []
        for pg in ch["pages"]:
            im = pdf[pg["page_no"] - 1].render(scale=400 / 72).to_pil()
            im.thumbnail((2048, 2048))
            imgs.append(im)
        t0 = time.time()
        with ThreadPoolExecutor(16) as ex:
            res = list(ex.map(lambda im: ocr(args.api, im, args.max_tokens), imgs))
        secs = time.time() - t0
        lo = {**raw, "chandra": {**ch, "pages": [{"page_no": pg["page_no"], "raw": to_html(md)}
                                                 for pg, (md, _, _) in zip(ch["pages"], res)]}}
        r = {"sha256": sha, "title": title, "date": date, "engine": engine, "pages": len(imgs), "secs": round(secs, 1),
             "tokens": sum(t for _, t, _ in res), "truncated": sum(f != "stop" for _, _, f in res)}
        for name, rr in (("chandra", raw), ("lighton", lo)):     # "chandra": the stored raw, whichever engine
            text = ("\n".join(html_text(p["raw"]) for p in rr["chandra"]["pages"]) if rr.get("chandra")
                    else "\n".join(b["text"] for b in blocks(rr) if b["role"] != "furniture"))
            rate, nw = word_rate(text)
            try:
                r[name] = {**summary(act(blocks(rr))), "dict_words": round(rate, 3), "words": nw}
            except Exception as e:          # a structure crash on one engine's output is a result too
                r[name] = {"error": repr(e)[:200], "dict_words": round(rate, 3), "words": nw}
        old = {}
        if engine == "surya":
            for b in blocks(raw):
                old[b["page"]] = old.get(b["page"], "") + f"[{b['role']}] {b['text']}\n"
        with open(out / f"{title.replace(':', '').replace('/', '_')}.txt" if args.acts else out / f"{sha[:12]}.txt", "w") as f:
            for pg, (md, _, fin) in zip(ch["pages"], res):
                f.write(f"===== page {pg['page_no']} {engine.upper()}\n{old.get(pg['page_no']) or html_text(pg['raw'])}\n"
                        f"===== page {pg['page_no']} LIGHTON ({fin})\n{md}\n\n")
        report.append(r)
        done += 1
        c, l = r["chandra"], r["lighton"]
        print(f"{title[:50]!r} {date} {engine} {r['pages']}p {secs:.0f}s {r['tokens']} tok trunc={r['truncated']} | "
              f"chandra {c.get('sections')}s/{c.get('notes')}n/{c.get('warnings')}w dict {c['dict_words']} | "
              f"lighton {l.get('sections')}s/{l.get('notes')}n/{l.get('warnings')}w dict {l['dict_words']}", flush=True)
    (out / ("report_acts.json" if args.acts else "report.json")).write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
