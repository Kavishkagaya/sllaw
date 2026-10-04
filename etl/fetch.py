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
import argparse, hashlib, os, time

import boto3
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json

from etl.spiders import acts

load_dotenv()
DELAY = 0.5   # seconds between downloads; documents.gov.lk is a small govt server


def discover_acts(cur):
    """Upsert one row per (act, language) file. The listing record is kept
    verbatim in meta so nothing from the source is lost."""
    n = 0
    for rec in acts.crawl():
        for c in rec.get("contents") or []:
            cur.execute(
                """INSERT INTO documents (source, source_url, title, doc_date, meta)
                   VALUES ('acts', %s, %s, %s, %s)
                   ON CONFLICT (source, source_url) DO UPDATE
                   SET meta = documents.meta || EXCLUDED.meta, updated_at = NOW()""",
                (acts.pdf_url(c["uploadedFile"]), rec.get("descriptionEnglish"), rec.get("date"),
                 Json({"act_no": rec.get("actNoText"), "lang": c["language"], "listing": rec})))
            n += 1
    return n


def r2():
    return boto3.client(
        "s3", region_name="auto",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])


def fetch(conn, source, limit=None):
    s3, bucket, cur = r2(), os.environ["R2_BUCKET"], conn.cursor()
    cur.execute("SELECT id, source_url FROM documents WHERE source = %s AND r2_key IS NULL "
                "ORDER BY id LIMIT %s", (source, limit))
    rows, ok, bad = cur.fetchall(), 0, 0
    for i, (did, url) in enumerate(rows, 1):
        try:
            blob = acts._get(url)
            if not blob.startswith(b"%PDF"):
                raise ValueError("not a PDF: " + blob[:80].decode("utf8", "replace"))
            sha = hashlib.sha256(blob).hexdigest()
            key = f"source/{sha}.pdf"
            # dedupe via the DB, not a HEAD request: Neon is free, R2 ops are not
            cur.execute("SELECT 1 FROM documents WHERE sha256 = %s AND r2_key IS NOT NULL LIMIT 1", (sha,))
            if not cur.fetchone():
                s3.put_object(Bucket=bucket, Key=key, Body=blob, ContentType="application/pdf")
            cur.execute("UPDATE documents SET sha256=%s, r2_key=%s, bytes=%s, fetched_at=NOW(), "
                        "error=NULL, updated_at=NOW() WHERE id=%s", (sha, key, len(blob), did))
            ok += 1
            msg = f"ok {len(blob) // 1024} KB"
        except (Exception, SystemExit) as e:   # acts._get raises SystemExit on HTTP errors
            conn.rollback()
            cur.execute("UPDATE documents SET error=%s, updated_at=NOW() WHERE id=%s",
                        (f"fetch: {e}"[:500], did))
            bad += 1
            msg = f"FAIL {e}"[:100]
        conn.commit()
        print(f"[{i}/{len(rows)}] doc {did}: {msg}", flush=True)
        time.sleep(DELAY)
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
