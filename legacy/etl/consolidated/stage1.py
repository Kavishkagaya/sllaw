#!/usr/bin/env python3
"""
stage1.py — Consolidated Statutes: Pass 1 (Docling)

Downloads PDF statutes and runs docling to produce docling_json cluster data,
stored in the consolidated_statutes table.  Does NOT build structured content.

HTML statutes are already handled inline by spider.py (no docling needed).

Usage:
  .venv/bin/python3 etl/consolidated/stage1.py --collection 2024
  .venv/bin/python3 etl/consolidated/stage1.py --collection 2024 --retry-failed
  .venv/bin/python3 etl/consolidated/stage1.py --statute-id 42
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))
from extract_statute import build_pdf_converter, run_docling_pass1

log = logging.getLogger("consolidated-stage1")

CRAWL_DELAY = 1.0


def setup_logging(log_file=None):
    fmt     = "%(asctime)s  %(levelname)-7s  %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt=datefmt, handlers=handlers)


def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set.")
    return psycopg2.connect(url)


def mark_failed(conn, statute_id, error):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE consolidated_statutes"
            " SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
            (str(error)[:500], statute_id),
        )
    conn.commit()


def _download_pdf(session, url: str, dest: Path) -> bool:
    try:
        resp = session.get(url, timeout=60)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        return True
    except Exception:
        return False


def process_statute(conn, session, converter, statute, pdf_dir: Path) -> bool:
    statute_id = statute["id"]
    url        = statute["source_url"]
    filename   = Path(url.split("/")[-1])
    dest       = pdf_dir / filename

    if not dest.exists():
        ok = _download_pdf(session, url, dest)
        if not ok:
            mark_failed(conn, statute_id, "download failed")
            return False
        time.sleep(CRAWL_DELAY)

    try:
        docling_json = run_docling_pass1(converter, str(dest))
    except Exception as exc:
        mark_failed(conn, statute_id, f"docling pass1: {exc}")
        dest.unlink(missing_ok=True)
        return False

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE consolidated_statutes SET
                    docling_json = %s,
                    status       = 'docling_done',
                    error        = NULL,
                    updated_at   = NOW()
                WHERE id = %s
                """,
                (json.dumps(docling_json), statute_id),
            )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        mark_failed(conn, statute_id, f"db write: {exc}")
        dest.unlink(missing_ok=True)
        return False

    dest.unlink(missing_ok=True)
    return True


def main():
    p = argparse.ArgumentParser(description="Consolidated stage1: docling pass")
    p.add_argument("--collection", help="Collection slug (e.g. 2024)")
    p.add_argument("--statute-id", type=int, help="Process a single statute by ID")
    p.add_argument("--retry-failed", action="store_true")
    p.add_argument("--pdf-dir", default=os.environ.get("PDF_DIR", "pdfs"))
    p.add_argument("--log-file", default=None)
    args = p.parse_args()

    setup_logging(args.log_file)

    conn    = get_conn()
    session = requests.Session()
    session.headers["User-Agent"] = "sllaw-spider/1.0 (legal research, non-commercial)"

    pdf_dir = Path(args.pdf_dir).expanduser().resolve()
    pdf_dir.mkdir(parents=True, exist_ok=True)

    if args.statute_id:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM consolidated_statutes WHERE id = %s",
                        (args.statute_id,))
            row = cur.fetchone()
        if not row:
            log.error("statute id %d not found", args.statute_id)
            sys.exit(1)
        pending = [row]
    elif args.collection:
        want = ["discovered"] + (["failed"] if args.retry_failed else [])
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM consolidated_statutes"
                " WHERE collection = %s AND source_type = 'pdf'"
                " AND status = ANY(%s) ORDER BY id",
                (args.collection, want),
            )
            pending = cur.fetchall()
    else:
        log.error("--collection or --statute-id required")
        sys.exit(1)

    if not pending:
        log.info("Nothing to process.")
        conn.close()
        return

    log.info("Processing %d PDF statutes", len(pending))
    converter = build_pdf_converter()
    ok_count = fail_count = 0
    for i, statute in enumerate(pending, 1):
        ok = process_statute(conn, session, converter, statute, pdf_dir)
        label = "ok" if ok else "FAIL"
        log.info("  [%4d/%d] %-45s  %s",
                 i, len(pending),
                 statute["source_url"].split("/")[-1], label)
        if ok:
            ok_count += 1
        else:
            fail_count += 1

    log.info("Done — %d ok, %d failed", ok_count, fail_count)
    conn.close()


if __name__ == "__main__":
    main()
