#!/usr/bin/env python3
"""CommonLII Sri Lanka "numbered Acts" (as enacted), from the Wayback Machine: only what we don't hold.

  python3 -m etl.spiders.commonlii targets.json --passes 4   # {"law:19/1978": "<commonlii index.html URL>", ...}

commonlii.org itself answers every request with a Cloudflare bot challenge (2026-10-09; not bypassed).
archive.org holds its /lk/legis/num_act/ mostly as of 2008: one directory per Act, index.html (table of
provisions) + longtitle.html + s1.html, s2.html ... (one page per section: <H3> title, the marginal note
as <p><b>..</b></p>, then the text). 1,767 numbers; 120 we held no file for on 2026-10-09 (SOURCES.md).
Each Act's pages are joined unchanged into one file, "<!-- commonlii num_act <dir> -->" then
"<!-- page <name> -->" + the page, stored as source/<sha256>.html with a documents row (source
'commonlii'); etl.structure.commonlii_rows() reads it. Pages are fetched one at a time with a pause:
8 at a time got "Connection refused" from archive.org within minutes (2026-10-09). A refused or failed
page backs off (1, 2, 4, 8, 15 min); an Act that still fails is retried on the next pass (--passes).
"""
import argparse, hashlib, json, os, re, sys, time, urllib.request

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json

from etl.fetch import r2

PAUSE = 3.0        # seconds between archive.org requests
BACKOFF = [60, 120, 240, 480, 900]


def get(url):
    for i in range(len(BACKOFF) + 1):
        try:
            req = urllib.request.Request(f"https://web.archive.org/web/2008id_/{url}", headers={"User-Agent": "sllaw/1.0"})
            return urllib.request.urlopen(req, timeout=120).read().decode("latin-1")
        except Exception as e:
            if i == len(BACKOFF) or getattr(e, "code", None) == 404:
                raise
            print(f"    {e} -> waiting {BACKOFF[i]} s", flush=True)
            time.sleep(BACKOFF[i])
        finally:
            time.sleep(PAUSE)


def bundle(index_url):
    """index.html, then every page it links in its own order (long title, sections, schedules)."""
    base = index_url.rsplit("/", 1)[0] + "/"
    index = get(index_url)
    names = list(dict.fromkeys(n for n in re.findall(r'HREF="([^"/?]+\.html)"', index, re.I) if n.lower() != "index.html"))
    parts = [f"<!-- commonlii num_act {base.rstrip('/').rsplit('/', 1)[1]} -->", "<!-- page index.html -->", index]
    for n in names:
        parts += [f"<!-- page {n} -->", get(base + n)]
    return "\n".join(parts), len(names)


def main():
    load_dotenv()
    a = argparse.ArgumentParser()
    a.add_argument("targets", help='json {"law:19/1978": "<commonlii index.html URL>", ...}')
    a.add_argument("--passes", type=int, default=1, help="retry failed Acts this many times, 15 min apart")
    args = a.parse_args()
    targets = json.load(open(args.targets))
    for n in range(args.passes):
        left = fetch_pass(targets)
        print(f"pass {n + 1}: {left} Acts still missing", flush=True)
        if not left:
            break
        if n + 1 < args.passes:
            time.sleep(900)


def fetch_pass(targets):
    """One pass over the targets not yet stored -> how many are still missing."""
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        cur.execute("SELECT source_url FROM documents WHERE source = 'commonlii' AND r2_key IS NOT NULL")
        done = {r[0] for r in cur.fetchall()}
    conn.close()
    ok = bad = 0
    for i, (key, url) in enumerate(sorted(targets.items()), 1):
        if url in done:
            continue
        try:
            html, n = bundle(url)
            blob = html.encode("utf8")
            sha = hashlib.sha256(blob).hexdigest()
            s3.put_object(Bucket=bucket, Key=f"source/{sha}.html", Body=blob, ContentType="text/html")
            kind, no = key.split(":")
            title = re.search(r"<TITLE>\s*(.*?)\s*</TITLE>", html, re.I | re.S)
            conn = psycopg2.connect(os.environ["DATABASE_URL"])     # one per file: Neon drops idle connections
            with conn, conn.cursor() as cur:
                cur.execute("""INSERT INTO documents (source, source_url, title, doc_date, meta, sha256, r2_key, bytes, fetched_at)
                               VALUES ('commonlii', %s, %s, %s, %s, %s, %s, %s, NOW())
                               ON CONFLICT (source, source_url) DO UPDATE SET sha256 = EXCLUDED.sha256, r2_key = EXCLUDED.r2_key,
                                   bytes = EXCLUDED.bytes, fetched_at = NOW(), error = NULL, updated_at = NOW()""",
                            (url, title and re.sub(r"\s+", " ", title[1]), f"{no[-4:]}-01-01",
                             Json({"act_no": no, "kind": kind, "lang": "ENGLISH", "format": "html", "date_precision": "year",
                                   "listing": {"key": key, "url": url, "wayback": "2008"}}),
                             sha, f"source/{sha}.html", len(blob)))
            conn.close()
            ok += 1
            print(f"[{i}/{len(targets)}] {key}: ok, {n} pages, {len(blob) // 1024} KB", flush=True)
        except Exception as e:
            bad += 1
            print(f"[{i}/{len(targets)}] {key}: FAIL {e}"[:200], flush=True)
    print(f"\n{ok} fetched, {bad} failed (re-run to retry; done ones are skipped)", flush=True)
    return bad


if __name__ == "__main__":
    main()
