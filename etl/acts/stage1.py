#!/usr/bin/env python3
"""
stage1.py — Docling extraction stage (Pass 1)

Runs docling on a PDF or HTML file and writes docling_json to the database.
For HTML, text clusters are synthesised from docling document items (no
column-gap detection — HTML acts are single-column).

Usage:
  .venv/bin/python3 etl/acts/stage1.py <path> [--act-id N]
  .venv/bin/python3 etl/acts/stage1.py --all [--year 2024] [--retry-failed]
  .venv/bin/python3 etl/acts/stage1.py --year 2024

Status transition: downloaded → docling_done
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
from extract_act import build_converter, detect_page_type, serialize_clusters

log = logging.getLogger("stage1")


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


# ── Docling runners ───────────────────────────────────────────────────────────

def _run_pdf(path: Path) -> dict:
    import pypdfium2 as pdfium
    converter = build_converter()
    result    = converter.convert(str(path.resolve()))
    total     = len(pdfium.PdfDocument(str(path)))
    pages     = []
    for pg_idx in range(total):
        if pg_idx >= len(result.pages):
            break
        clusters = result.pages[pg_idx].predictions.layout.clusters
        ptype    = detect_page_type(clusters)
        pages.append({
            "index":     pg_idx,
            "page_type": ptype,
            "clusters":  serialize_clusters(clusters),
        })
    return {"total_pages": total, "pages": pages, "source_type": "pdf"}


def _run_html(path: Path) -> dict:
    from docling.document_converter import DocumentConverter
    converter = DocumentConverter()
    result    = converter.convert(str(path.resolve()))
    doc       = result.document
    clusters  = []
    for i, text_item in enumerate(doc.texts):
        t = text_item.text.strip() if hasattr(text_item, "text") else ""
        if not t:
            continue
        raw_label = getattr(text_item, "label", None)
        label     = raw_label.value if hasattr(raw_label, "value") else "text"
        y0, y1    = float(i * 20), float((i + 1) * 20)
        clusters.append({
            "label": str(label),
            "bbox":  {"t": y0, "b": y1},
            "cells": [{"text": t, "x0": 0.0, "y0": y0, "x1": 500.0, "y1": y1}],
        })
    return {
        "total_pages": 1,
        "pages":       [{"index": 0, "page_type": "text", "clusters": clusters}],
        "source_type": "html",
    }


# ── Core processing ───────────────────────────────────────────────────────────

def process_file(conn, path: Path, act_id: int | None = None) -> bool:
    path   = path.resolve()
    suffix = path.suffix.lower()

    try:
        docling_json = _run_html(path) if suffix in (".html", ".htm") else _run_pdf(path)
    except Exception as exc:
        log.error("docling failed on %s: %s", path, exc)
        if act_id:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE acts SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
                        (f"stage1: {exc}"[:500], act_id),
                    )
                conn.commit()
            except Exception:
                conn.rollback()
        return False

    # If no act_id given, try to locate the DB record from the file path / URL
    if act_id is None:
        fname = path.name
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id FROM acts WHERE pdf_path = %s OR pdf_url LIKE %s LIMIT 1",
                (str(path), f"%{fname}"),
            )
            row = cur.fetchone()
        if row:
            act_id = row["id"]
        else:
            # No DB record — write JSON to disk for inspection
            out = path.with_suffix(".docling.json")
            out.write_text(json.dumps(docling_json, indent=2, ensure_ascii=False))
            log.info("No DB record found for %s — wrote %s", path.name, out)
            return True

    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE acts SET docling_json=%s, status='docling_done', error=NULL,"
                " updated_at=NOW() WHERE id=%s",
                (json.dumps(docling_json), act_id),
            )
        conn.commit()
        n_pages = len(docling_json["pages"])
        log.info("act_id=%-5d  %2d pages  source=%s  → docling_done",
                 act_id, n_pages, docling_json["source_type"])
        return True
    except Exception as exc:
        conn.rollback()
        log.error("DB write failed act_id=%s: %s", act_id, exc)
        return False


def batch_process(conn, years=None, retry_failed=False):
    want = ["downloaded"] + (["failed"] if retry_failed else [])
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if years:
            cur.execute(
                "SELECT id, pdf_path, act_number FROM acts"
                " WHERE status = ANY(%s) AND year = ANY(%s)"
                " ORDER BY year, act_number",
                (want, list(years)),
            )
        else:
            cur.execute(
                "SELECT id, pdf_path, act_number FROM acts"
                " WHERE status = ANY(%s)"
                " ORDER BY year, act_number",
                (want,),
            )
        acts = cur.fetchall()

    log.info("[stage1] %d acts to process", len(acts))
    ok_n = fail_n = 0
    for i, act in enumerate(acts, 1):
        if not act["pdf_path"]:
            log.warning("  [%4d/%d] %-12s  no pdf_path — skip", i, len(acts), act["act_number"])
            fail_n += 1
            continue
        ok = process_file(conn, Path(act["pdf_path"]), act_id=act["id"])
        log.info("  [%4d/%d] %-12s  %s", i, len(acts), act["act_number"], "ok" if ok else "FAIL")
        if ok:
            ok_n += 1
        else:
            fail_n += 1

    log.info("[stage1] done  %d ok / %d failed", ok_n, fail_n)


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Stage 1 — docling extraction for acts")
    p.add_argument("path",          nargs="?", help="PDF or HTML file path")
    p.add_argument("--act-id",      type=int,  help="DB act id to update (optional with path)")
    p.add_argument("--all",         action="store_true", help="Process all downloaded acts")
    p.add_argument("--year",        type=int,  help="Limit to a single year")
    p.add_argument("--retry-failed", action="store_true")
    return p.parse_args()


def main():
    args = parse_args()
    setup_logging()

    if not args.path and not args.all and not args.year:
        sys.exit("Provide a path, --all, or --year")

    conn = get_conn()

    if args.path:
        ok = process_file(conn, Path(args.path), act_id=args.act_id)
        conn.close()
        sys.exit(0 if ok else 1)
    else:
        years = [args.year] if args.year else None
        batch_process(conn, years=years, retry_failed=args.retry_failed)
        conn.close()


if __name__ == "__main__":
    main()
