#!/usr/bin/env python3
"""
stage2.py — Consolidated Statutes: Pass 2 (Structure Build)

Reads docling_json from consolidated_statutes rows and builds the structured
document (parts, sections, schedules).  If the extractor hits an unknown
structural pattern it flags the row (status='flagged') so it can be retried
after adding new pattern support.

Usage:
  .venv/bin/python3 etl/consolidated/stage2.py --collection 2024
  .venv/bin/python3 etl/consolidated/stage2.py --flagged        # reprocess only flagged rows
  .venv/bin/python3 etl/consolidated/stage2.py --all            # all collections
  .venv/bin/python3 etl/consolidated/stage2.py --statute-id 42
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))
from extract_statute import build_document_pdf

log = logging.getLogger("consolidated-stage2")


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


def process_statute(conn, statute) -> bool:
    statute_id   = statute["id"]
    docling_json = statute.get("docling_json")
    if docling_json is None:
        mark_failed(conn, statute_id, "pass2: no docling_json stored")
        return False

    try:
        data = build_document_pdf(docling_json)
    except Exception as exc:
        mark_failed(conn, statute_id, f"pass2 build: {exc}")
        return False

    parts    = data["parts"]
    sections = data["sections"]
    stopped  = data.get("stopped", False)
    flags    = data.get("flags", [])
    final_status = "flagged" if stopped else "extracted"

    doc = {
        "title":        data["title"],
        "description":  data["description"],
        "enacted_date": data["enacted_date"],
        "is_repealed":  data["is_repealed"],
        "source_url":   statute["source_url"],
        "parts":        parts,
        "sections":     sections,
        "schedules":    data.get("schedules", []),
        "flags":        flags,
        "stopped":      stopped,
    }

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE consolidated_statutes SET
                    title          = %s,
                    description    = %s,
                    enacted_date   = %s,
                    is_repealed    = %s,
                    parts_count    = %s,
                    sections_count = %s,
                    doc_json       = %s,
                    raw_json       = %s,
                    status         = %s,
                    error          = NULL,
                    updated_at     = NOW()
                WHERE id = %s
                """,
                (
                    data["title"],
                    data["description"],
                    data["enacted_date"],
                    data["is_repealed"],
                    len(parts),
                    len(sections),
                    json.dumps(doc),
                    json.dumps(doc),
                    final_status,
                    statute_id,
                ),
            )
            for p in parts:
                cur.execute(
                    """
                    INSERT INTO consolidated_parts
                        (statute_id, part_number, title, section_numbers, part_type)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (statute_id, part_number) DO UPDATE
                        SET title           = EXCLUDED.title,
                            section_numbers = EXCLUDED.section_numbers
                    """,
                    (statute_id, p["number"], p.get("title", ""),
                     p.get("sections", []), p.get("type", "part")),
                )
            for num_str, s in sections.items():
                cur.execute(
                    """
                    INSERT INTO consolidated_sections
                        (statute_id, section_number, short_title, part_number, body)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (statute_id, section_number) DO UPDATE
                        SET short_title = EXCLUDED.short_title,
                            body        = EXCLUDED.body
                    """,
                    (statute_id, num_str, s.get("short_title"),
                     s.get("part"), json.dumps(s.get("body", []))),
                )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        mark_failed(conn, statute_id, f"db write: {exc}")
        return False

    if stopped and flags:
        log.warning("  [flagged] %s  flags: %s",
                    statute["source_url"].split("/")[-1], flags[:3])
    return True


def main():
    p = argparse.ArgumentParser(description="Consolidated stage2: structure build")
    p.add_argument("--collection", help="Collection slug (e.g. 2024)")
    p.add_argument("--all",        action="store_true",
                   help="Process all collections")
    p.add_argument("--flagged",    action="store_true",
                   help="Reprocess only flagged rows (after adding new pattern support)")
    p.add_argument("--statute-id", type=int, help="Process a single statute by ID")
    p.add_argument("--log-file",   default=None)
    args = p.parse_args()

    setup_logging(args.log_file)
    conn = get_conn()

    if args.statute_id:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM consolidated_statutes WHERE id = %s",
                        (args.statute_id,))
            row = cur.fetchone()
        if not row:
            log.error("statute id %d not found", args.statute_id)
            sys.exit(1)
        pending = [row]

    elif args.flagged or args.all or args.collection:
        if args.flagged:
            want = ["flagged"]
        else:
            want = ["docling_done", "flagged"]

        if args.all or not args.collection:
            q = ("SELECT * FROM consolidated_statutes"
                 " WHERE source_type = 'pdf' AND status = ANY(%s) ORDER BY id")
            qparams = (want,)
        else:
            q = ("SELECT * FROM consolidated_statutes"
                 " WHERE collection = %s AND source_type = 'pdf'"
                 " AND status = ANY(%s) ORDER BY id")
            qparams = (args.collection, want)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(q, qparams)
            pending = cur.fetchall()
    else:
        log.error("Specify --collection, --all, --flagged, or --statute-id")
        sys.exit(1)

    if not pending:
        log.info("Nothing to process.")
        conn.close()
        return

    log.info("Building structure for %d PDF statutes", len(pending))
    ok_count = fail_count = flag_count = 0
    for i, statute in enumerate(pending, 1):
        ok = process_statute(conn, statute)
        if ok:
            ok_count += 1
            # Re-read status to check if it was flagged
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM consolidated_statutes WHERE id = %s",
                            (statute["id"],))
                status = cur.fetchone()[0]
            if status == "flagged":
                flag_count += 1
        else:
            fail_count += 1
        log.info("  [%4d/%d] %-45s  %s",
                 i, len(pending),
                 statute["source_url"].split("/")[-1],
                 "ok" if ok else "FAIL")

    log.info("Done — %d ok (%d flagged), %d failed",
             ok_count, flag_count, fail_count)
    if flag_count:
        log.info("  Add pattern support to extract_statute.py / extract_act.py"
                 " then rerun with --flagged")

    conn.close()


if __name__ == "__main__":
    main()
