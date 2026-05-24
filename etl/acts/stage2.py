#!/usr/bin/env python3
"""
stage2.py — Structure building stage (Pass 2)

Reads docling_json from the database and builds structured doc_json.
If an unknown structural pattern is encountered the act is saved with
partial output and status='flagged'. Re-run with --flagged after adding
support for that pattern in extract_act.py.

Usage:
  .venv/bin/python3 etl/acts/stage2.py --all [--year 2024]
  .venv/bin/python3 etl/acts/stage2.py --flagged       # reprocess after parser fix
  .venv/bin/python3 etl/acts/stage2.py --act-id 42

Status transitions: docling_done → extracted | flagged
Re-run:            flagged      → extracted
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
from extract_act import build_document

log = logging.getLogger("stage2")


def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set. Add it to .env or export it.")
    return psycopg2.connect(url)


# ── Core processing ───────────────────────────────────────────────────────────

def process_act(conn, act) -> bool:
    act_id       = act["id"]
    docling_json = act.get("docling_json")
    if not docling_json:
        log.error("act_id=%d has no docling_json — run stage1 first", act_id)
        return False

    try:
        doc = build_document(docling_json)
    except Exception as exc:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE acts SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
                    (f"stage2: {exc}"[:500], act_id),
                )
            conn.commit()
        except Exception:
            conn.rollback()
        return False

    # doc.get("stopped") only exists in old doc_json written before this parser
    # version; new runs never set it.  Both cases land in "extracted" now since
    # the parser no longer hard-stops — unknown content goes to doc["rest"].
    final_status = "stopped" if doc.get("stopped") else "extracted"

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE acts SET
                    title          = %s,
                    certified      = %s,
                    total_pages    = %s,
                    parts_count    = %s,
                    sections_count = %s,
                    doc_json       = %s,
                    flagged        = %s,
                    flag_reasons   = %s,
                    status         = %s,
                    error          = NULL,
                    updated_at     = NOW()
                WHERE id = %s
                """,
                (
                    doc["title"],
                    doc["certified"],
                    doc["total_pages"],
                    len(doc["parts"]),
                    len(doc["sections"]),
                    json.dumps(doc),
                    bool(doc["flags"]),
                    doc["flags"],
                    final_status,
                    act_id,
                ),
            )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        log.error("DB write failed act_id=%d: %s", act_id, exc)
        return False

    return True


def _act_status(conn, act_id) -> tuple[str, list]:
    with conn.cursor() as cur:
        cur.execute("SELECT status, flag_reasons FROM acts WHERE id=%s", (act_id,))
        row = cur.fetchone()
    return (row[0], row[1]) if row else ("?", [])


def batch_process(conn, statuses: list[str], years=None):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if years:
            cur.execute(
                "SELECT id, act_number, docling_json FROM acts"
                " WHERE status = ANY(%s) AND year = ANY(%s)"
                " ORDER BY year, act_number",
                (statuses, list(years)),
            )
        else:
            cur.execute(
                "SELECT id, act_number, docling_json FROM acts"
                " WHERE status = ANY(%s)"
                " ORDER BY year, act_number",
                (statuses,),
            )
        acts = cur.fetchall()

    log.info("[stage2] %d acts to process", len(acts))
    ok_n = rest_n = fail_n = 0

    for i, act in enumerate(acts, 1):
        ok     = process_act(conn, act)
        status, reasons = _act_status(conn, act["id"])

        rest_flags = [r for r in reasons if r.startswith("rest:")]
        if not ok:
            label  = "FAIL"
            fail_n += 1
        elif rest_flags:
            label  = f"ok+rest  {rest_flags[0][:55]}"
            ok_n  += 1
            rest_n += 1
        else:
            label = "ok"
            ok_n += 1

        log.info("  [%4d/%d] %-12s  %s", i, len(acts), act["act_number"], label)

    log.info("[stage2] done  %d extracted (%d with rest content) / %d failed",
             ok_n, rest_n, fail_n)
    if rest_n:
        log.info("  Inspect rest content: check flag_reasons starting with 'rest:'")


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Stage 2 — structure building for acts")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--act-id",  type=int, help="Process a single act by DB id")
    g.add_argument("--all",     action="store_true", help="Process all docling_done acts")
    g.add_argument("--flagged", action="store_true", help="Reprocess stopped/flagged acts (status=stopped or status=flagged)")
    p.add_argument("--year",    type=int, help="Limit to a single year (use with --all)")
    return p.parse_args()


def main():
    args = parse_args()
    setup_logging()

    if not any([args.act_id, args.all, args.flagged]):
        sys.exit("Provide --act-id N, --all, or --flagged")

    conn = get_conn()

    if args.act_id:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, act_number, docling_json FROM acts WHERE id=%s",
                (args.act_id,),
            )
            act = cur.fetchone()
        if not act:
            sys.exit(f"No act with id={args.act_id}")
        ok = process_act(conn, act)
        status, reasons = _act_status(conn, args.act_id)
        rest_flags = [r for r in reasons if r.startswith("rest:")]
        if rest_flags:
            log.warning("rest content: %s", rest_flags)
        conn.close()
        sys.exit(0 if ok else 1)

    # "stopped" = new name; "flagged" = old status value before migration
    statuses = ["stopped", "flagged"] if args.flagged else ["docling_done"]
    years    = [args.year] if args.year else None
    batch_process(conn, statuses, years)
    conn.close()


if __name__ == "__main__":
    main()
