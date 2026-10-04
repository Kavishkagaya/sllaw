#!/usr/bin/env python3
"""Fetch step: list a source, archive every file once in R2, record it in Neon.

  python3 -m etl.fetch acts                 # discover + fetch everything new
  python3 -m etl.fetch acts --limit 20      # pilot
  python3 -m etl.fetch acts --no-discover   # only drain the fetch queue

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

from etl.spiders import acts

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
            for rec in acts.crawl() for c in rec.get("contents") or []}
    execute_values(cur,
        """INSERT INTO documents (source, source_url, title, doc_date, meta) VALUES %s
           ON CONFLICT (source, source_url) DO UPDATE
           SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""",
        list(rows.values()), page_size=1000)
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
        blob = acts._get(url)
        if not blob.startswith(b"%PDF"):
            raise ValueError("not a PDF: " + blob[:80].decode("utf8", "replace"))
        sha = hashlib.sha256(blob).hexdigest()
        key = f"source/{sha}.pdf"
        # two workers racing on the same sha both put the same bytes to the same key: harmless
        if sha not in stored:
            s3.put_object(Bucket=bucket, Key=key, Body=blob, ContentType="application/pdf")
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
    a.add_argument("source", choices=["acts"])
    a.add_argument("--limit", type=int, help="fetch at most N files (pilot)")
    a.add_argument("--no-discover", action="store_true", help="skip listing, only drain the queue")
    args = a.parse_args()

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    if not args.no_discover:
        with conn.cursor() as cur:
            print(f"discovered {discover_acts(cur)} files")
        conn.commit()
    fetch(conn, args.source, args.limit)
    conn.close()


if __name__ == "__main__":
    main()
