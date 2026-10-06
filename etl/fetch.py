#!/usr/bin/env python3
"""Fetch step: list a source, archive every file once in R2, record it in Neon.

  python3 -m etl.fetch acts                 # discover + fetch everything new
  python3 -m etl.fetch acts --limit 20      # pilot
  python3 -m etl.fetch acts --no-discover   # only drain the fetch queue
  python3 -m etl.fetch le1980               # Legislative Enactments 1980 (lankalaw.net), one row per chapter
  python3 -m etl.fetch lankalaw             # lankalaw.net Acts by year, only those filling a gap

One documents row per file (an act in three languages = three rows). Files are
keyed by content hash, source/<sha256>.pdf, so re-runs and duplicates never
write twice and nothing is overwritten. The queue is `r2_key IS NULL`: a crash
or a failed download just means run it again.
"""
import argparse, hashlib, os
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl.spiders import acts, lankalaw, le1980

load_dotenv()
WORKERS = 8   # parallel downloads; documents.gov.lk is a small govt server, don't go much higher
BATCH = 50    # results per Neon write


def discover_acts(cur):
    """Upsert one row per (act, language) file. The listing record is kept
    verbatim in meta so nothing from the source is lost."""
    # one batched statement: row-by-row inserts cost a Neon round trip each (minutes from ada).
    # dict dedupes by URL: one VALUES list can't upsert the same key twice.
    rows = {acts.pdf_url(c["uploadedFile"]): (
                "acts", acts.pdf_url(c["uploadedFile"]), rec.get("descriptionEnglish"), rec.get("date"),
                Json({"act_no": rec.get("actNoText"), "lang": c["language"], "listing": rec}))
            for rec in acts.crawl() for c in rec.get("contents") or []
            if c["language"] != "TAMIL"}   # Tamil out of scope (user, 2026-10-06)
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""",
        list(rows.values()), page_size=1000)
    return len(rows)


def discover_le1980(cur):
    """One row per chapter PDF; meta.cap is the chapter number (graph node cap:N)."""
    rows = [("le1980", r["url"], r["title"], None,
             Json({"cap": r["cap"], "lang": "ENGLISH", "listing": r})) for r in le1980.crawl()]
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


def discover_lankalaw(cur):
    """lankalaw.net rows only for Acts with no English file from documents.gov.lk (listed without
    English, or not listed at all), 1980 onwards: 731 files on 2026-10-05 (573 PDF, 158 HTML). Same act_no, so the same
    graph node. doc_date is the year's 1 January until the Act's own "[Certified on ...]" is read."""
    cur.execute("SELECT DISTINCT meta->>'act_no' FROM documents WHERE source = 'acts' AND meta->>'lang' = 'ENGLISH'")
    have = {r[0] for r in cur.fetchall()}
    rows = [("lankalaw", r["url"], r["title"], f"{r['act_no'].split('/')[1]}-01-01",
             Json({"act_no": r["act_no"], "lang": "ENGLISH", "format": r["format"], "date_precision": "year",
                   "listing": r}))
            # 1980 onwards only (decision 2026-10-05): pre-1980 law waits
            for r in lankalaw.crawl(range(1980, 2027)) if r["act_no"] not in have
            and not r["url"].endswith(("_S.pdf", "_T.pdf"))   # documents.gov.lk Sinhala/Tamil, listed as English
            and 1980 <= int(r["act_no"].split("/")[1]) <= 2026]
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""", rows, page_size=1000)
    return len(rows)


def r2():
    return boto3.client(
        "s3", region_name="auto",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])


def download(s3, bucket, stored, did, url):
    """One file: download, hash, put to R2 unless already stored. Runs in a worker thread."""
    try:
        try:
            blob = acts._get(url)
        except (Exception, SystemExit):   # dead host, expired cert, 404: closest raw Wayback snapshot
            blob = acts._get(f"https://web.archive.org/web/2id_/{url}")
        html = url.lower().endswith((".html", ".htm"))    # lankalaw serves some Acts as HTML pages
        if html and b"<" not in blob[:2000]:
            raise ValueError("not HTML: " + blob[:80].decode("utf8", "replace"))
        if not html and not blob.startswith(b"%PDF"):
            raise ValueError("not a PDF: " + blob[:80].decode("utf8", "replace"))
        sha = hashlib.sha256(blob).hexdigest()
        key = f"source/{sha}.{'html' if html else 'pdf'}"
        # two workers racing on the same sha both put the same bytes to the same key: harmless
        if sha not in stored:
            s3.put_object(Bucket=bucket, Key=key, Body=blob, ContentType="text/html" if html else "application/pdf")
            stored.add(sha)
        return did, sha, key, len(blob), None
    except (Exception, SystemExit) as e:   # acts._get raises SystemExit on HTTP errors
        return did, None, None, None, f"fetch: {e}"[:500]


def save(cur, results):
    ok = [r[:4] for r in results if not r[4]]
    bad = [(r[0], r[4]) for r in results if r[4]]
    if ok:
        execute_values(cur, """UPDATE documents d SET sha256=v.sha, r2_key=v.key, bytes=v.n,
            fetched_at=NOW(), error=NULL, updated_at=NOW()
            FROM (VALUES %s) AS v(id, sha, key, n) WHERE d.id = v.id""", ok)
    if bad:
        execute_values(cur, """UPDATE documents d SET error=v.err, updated_at=NOW()
            FROM (VALUES %s) AS v(id, err) WHERE d.id = v.id""", bad)


def fetch(conn, source, limit=None):
    s3, bucket, cur = r2(), os.environ["R2_BUCKET"], conn.cursor()
    # hashes already in R2, loaded once: Neon round trips from ada cost more than the downloads
    cur.execute("SELECT DISTINCT sha256 FROM documents WHERE r2_key IS NOT NULL")
    stored = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT id, source_url FROM documents WHERE source = %s AND r2_key IS NULL "
                "ORDER BY id LIMIT %s", (source, limit))
    rows, ok, bad, done = cur.fetchall(), 0, 0, []
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, r in enumerate(as_completed([pool.submit(download, s3, bucket, stored, *row)
                                            for row in rows]), 1):
            did, _, _, size, err = r.result()
            done.append(r.result())
            ok, bad = ok + (not err), bad + bool(err)
            print(f"[{n}/{len(rows)}] doc {did}: {f'FAIL {err}'[:100] if err else f'ok {size // 1024} KB'}",
                  flush=True)
            if len(done) >= BATCH or n == len(rows):
                save(cur, done)
                conn.commit()
                done = []
    print(f"\n{ok} fetched, {bad} failed (failed rows stay queued; re-run to retry)")


def main():
    a = argparse.ArgumentParser()
    a.add_argument("source", choices=["acts", "le1980", "lankalaw"])
    a.add_argument("--limit", type=int, help="fetch at most N files (pilot)")
    a.add_argument("--no-discover", action="store_true", help="skip listing, only drain the queue")
    args = a.parse_args()

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    if not args.no_discover:
        with conn.cursor() as cur:
            discover = {"acts": discover_acts, "le1980": discover_le1980, "lankalaw": discover_lankalaw}[args.source]
            print(f"discovered {discover(cur)} files")
        conn.commit()
    fetch(conn, args.source, args.limit)
    conn.close()


if __name__ == "__main__":
    main()
