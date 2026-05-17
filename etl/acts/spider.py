#!/usr/bin/env python3
"""
spider.py — Sri Lanka Legal Acts Spider

Crawls documents.gov.lk/view/act/ for acts from 2006 onwards,
downloads English PDFs, extracts structure via extract_act.py,
and stores results in Neon PostgreSQL.

Local usage (.venv):
  .venv/bin/python3 etl/acts/spider.py

On ada (conda env):
  ~/miniconda3/envs/sllaw/bin/python etl/acts/spider.py
  ~/miniconda3/envs/sllaw/bin/python etl/acts/spider.py --pdf-dir ~/sllaw/pdfs --log-file ~/sllaw/acts_spider.log

Flags:
  --year 2024                single year
  --years 2010-2015          year range
  --pdf-dir PATH             where to store PDFs  (default: ./pdfs, or $PDF_DIR)
  --log-file PATH            also write logs to this file
  --discover-only            only populate acts table
  --download-only            only download PDFs
  --extract-only             only extract already-downloaded PDFs
  --retry-failed             include failed acts in download/extract phases
  --stats                    print DB status counts and exit
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import psycopg2
import psycopg2.extras
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).parent))
from extract_act import (
    build_converter,
    build_structure,
    detect_page_type,
    extract_cover_metadata,
    page_elements,
)

# ── Constants ─────────────────────────────────────────────────────────────────

BASE_URL    = "https://documents.gov.lk/view/act/"
START_YEAR  = 2006
CRAWL_DELAY = 1.5   # seconds between outbound HTTP requests

log = logging.getLogger("spider")


# ── Logging setup ─────────────────────────────────────────────────────────────

def setup_logging(log_file=None):
    fmt = "%(asctime)s  %(levelname)-7s  %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt=datefmt, handlers=handlers)


# ── Database helpers ──────────────────────────────────────────────────────────

def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set. Add it to .env or export it.")
    return psycopg2.connect(url)


def fetch_acts(conn, statuses, years=None):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if years:
            cur.execute(
                "SELECT * FROM acts WHERE status = ANY(%s) AND year = ANY(%s)"
                " ORDER BY year, act_number",
                (list(statuses), list(years)),
            )
        else:
            cur.execute(
                "SELECT * FROM acts WHERE status = ANY(%s) ORDER BY year, act_number",
                (list(statuses),),
            )
        return cur.fetchall()


def _refetch(conn, act_id):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM acts WHERE id = %s", (act_id,))
        return cur.fetchone()


def mark_failed(conn, act_id, error):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE acts SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
            (str(error)[:500], act_id),
        )
    conn.commit()


def print_stats(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, COUNT(*) FROM acts GROUP BY status ORDER BY status"
        )
        rows = cur.fetchall()
    log.info("── DB status ──────────────────────────")
    if not rows:
        log.info("  (empty)")
        return
    for status, count in rows:
        log.info("  %-12s  %5d", status, count)


# ── Phase 1 — Discovery ───────────────────────────────────────────────────────

def discover_year(conn, session, year):
    """
    Fetch acts_YYYY.html, parse the act table, upsert new rows.
    Returns (new_rows_inserted, total_rows_found).
    """
    url  = f"{BASE_URL}acts_{year}.html"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    rows     = soup.select("table tbody tr")
    inserted = 0

    with conn.cursor() as cur:
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 4:
                continue

            act_number     = cells[0].get_text(strip=True)
            certified_date = cells[1].get_text(strip=True)
            description    = cells[2].get_text(strip=True)

            eng = cells[3].find("a", href=lambda h: h and h.endswith("_E.pdf"))
            if not eng:
                continue

            pdf_url = urljoin(url, eng["href"])

            cur.execute(
                """
                INSERT INTO acts (year, act_number, certified_date, description, pdf_url)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (year, act_number) DO NOTHING
                RETURNING id
                """,
                (year, act_number, certified_date, description, pdf_url),
            )
            if cur.fetchone():
                inserted += 1

    conn.commit()
    return inserted, len(rows)


# ── Phase 2 — Download ────────────────────────────────────────────────────────

def download_pdf(conn, session, act, pdf_dir):
    """
    Download the English PDF to pdf_dir/YYYY/<filename>.
    Updates status → 'downloaded'. Returns True on success.
    """
    act_id   = act["id"]
    pdf_url  = act["pdf_url"]
    filename = Path(urlparse(pdf_url).path).name
    dest_dir = pdf_dir / str(act["year"])
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename

    if not dest.exists():
        try:
            resp = session.get(pdf_url, timeout=60)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        except Exception as exc:
            mark_failed(conn, act_id, f"download: {exc}")
            return False

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE acts SET pdf_path=%s, status='downloaded', error=NULL,"
            " updated_at=NOW() WHERE id=%s",
            (str(dest), act_id),
        )
    conn.commit()
    return True


# ── Phase 3 — Extraction ──────────────────────────────────────────────────────

def extract_one(conn, converter, act):
    """
    Run the docling → extract_act pipeline on a downloaded PDF.
    Writes raw_json, parts, and sections to the DB.
    Updates status → 'extracted'. Returns True on success.
    """
    act_id   = act["id"]
    pdf_path = Path(act["pdf_path"])

    try:
        result      = converter.convert(str(pdf_path.resolve()))
        total_pages = len(pdfium.PdfDocument(str(pdf_path)))
        meta        = {}
        pages_data  = []

        for pg_idx in range(total_pages):
            if pg_idx >= len(result.pages):
                break
            clusters = result.pages[pg_idx].predictions.layout.clusters
            ptype    = detect_page_type(clusters)

            if pg_idx == 0:
                meta.update(extract_cover_metadata(clusters))

            if ptype == "text":
                pages_data.append(page_elements(clusters))
            else:
                pages_data.append(([], []))

        parts, sections = build_structure(pages_data)

        act_doc = {
            "title":       meta.get("title", ""),
            "number":      meta.get("number"),
            "year":        meta.get("year"),
            "certified":   meta.get("certified"),
            "source":      str(pdf_path),
            "total_pages": total_pages,
            "parts":       parts,
            "sections":    sections,
        }

    except Exception as exc:
        mark_failed(conn, act_id, f"extract: {exc}")
        return False

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
                    raw_json       = %s,
                    status         = 'extracted',
                    error          = NULL,
                    updated_at     = NOW()
                WHERE id = %s
                """,
                (
                    act_doc["title"],
                    act_doc["certified"],
                    total_pages,
                    len(parts),
                    len(sections),
                    json.dumps(act_doc),
                    act_id,
                ),
            )

            for p in parts:
                cur.execute(
                    """
                    INSERT INTO parts
                        (act_id, part_number, title, section_numbers, part_type)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (act_id, part_number) DO UPDATE
                        SET title           = EXCLUDED.title,
                            section_numbers = EXCLUDED.section_numbers
                    """,
                    (
                        act_id,
                        p["number"],
                        p.get("title", ""),
                        p.get("sections", []),
                        p.get("type", "part"),
                    ),
                )

            for num_str, s in sections.items():
                cur.execute(
                    """
                    INSERT INTO sections
                        (act_id, section_number, short_title, part_number, body)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (act_id, section_number) DO UPDATE
                        SET short_title = EXCLUDED.short_title,
                            body        = EXCLUDED.body
                    """,
                    (
                        act_id,
                        int(num_str),
                        s.get("short_title"),
                        s.get("part"),
                        json.dumps(s.get("body", [])),
                    ),
                )

        conn.commit()

    except Exception as exc:
        conn.rollback()
        mark_failed(conn, act_id, f"db write: {exc}")
        return False

    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Sri Lanka Legal Acts Spider")
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--year",  type=int, help="Single year, e.g. --year 2024")
    grp.add_argument("--years", type=str, help="Range, e.g. --years 2010-2015")
    p.add_argument("--pdf-dir",       default=os.environ.get("PDF_DIR", "pdfs"),
                   help="Directory to store downloaded PDFs (default: ./pdfs or $PDF_DIR)")
    p.add_argument("--log-file",      default=None,
                   help="Path to write log file (in addition to stdout)")
    p.add_argument("--discover-only", action="store_true")
    p.add_argument("--download-only", action="store_true")
    p.add_argument("--extract-only",  action="store_true")
    p.add_argument("--retry-failed",  action="store_true",
                   help="Include failed acts in download/extract phases")
    p.add_argument("--stats",         action="store_true",
                   help="Print DB status counts and exit")
    return p.parse_args()


def resolve_years(args):
    if args.year:
        return [args.year]
    if args.years:
        lo, hi = args.years.split("-")
        return list(range(int(lo), int(hi) + 1))
    return list(range(START_YEAR, datetime.now().year + 1))


def main():
    args = parse_args()
    setup_logging(args.log_file)

    pdf_dir = Path(args.pdf_dir).expanduser().resolve()
    conn    = get_conn()

    if args.stats:
        print_stats(conn)
        conn.close()
        return

    years = resolve_years(args)

    do_discover = not (args.download_only or args.extract_only)
    do_download = not (args.discover_only or args.extract_only)
    do_extract  = not (args.discover_only or args.download_only)

    session = requests.Session()
    session.headers["User-Agent"] = "sllaw-spider/1.0 (legal research, non-commercial)"

    # ── Phase 1: Discovery ────────────────────────────────────────────────────
    if do_discover:
        log.info("[discover] years %d–%d", years[0], years[-1])
        for year in years:
            try:
                inserted, total = discover_year(conn, session, year)
                log.info("  %d: %d acts found, %d new", year, total, inserted)
            except Exception as exc:
                log.error("  %d: ERROR — %s", year, exc)
            time.sleep(CRAWL_DELAY)

    # ── Phases 2+3: Download → Extract → Delete (one act at a time) ──────────
    # Default mode: stream through each act without accumulating PDFs on disk.
    # --download-only and --extract-only keep the old batch behaviour for debugging.
    if do_download and do_extract:
        want    = ["discovered", "downloaded"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[pipeline] %d acts to process  →  pdf tmp: %s", len(pending), pdf_dir)
        converter = build_converter()
        for i, act in enumerate(pending, 1):
            label = act["act_number"]

            # Download (skip if already on disk from a previous interrupted run)
            if act["status"] != "downloaded":
                ok = download_pdf(conn, session, act, pdf_dir)
                if not ok:
                    log.info("  [%4d/%d] %-12s  download FAIL", i, len(pending), label)
                    time.sleep(CRAWL_DELAY)
                    continue
                # Refresh act row so pdf_path is populated
                act = _refetch(conn, act["id"])
                time.sleep(CRAWL_DELAY)

            # Extract
            ok = extract_one(conn, converter, act)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending), label,
                     "ok" if ok else "extract FAIL")

            # Delete PDF to free disk space
            if ok and act.get("pdf_path"):
                try:
                    Path(act["pdf_path"]).unlink(missing_ok=True)
                except Exception:
                    pass

    elif do_download:
        want    = ["discovered"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[download] %d PDFs to fetch  →  %s", len(pending), pdf_dir)
        for i, act in enumerate(pending, 1):
            ok = download_pdf(conn, session, act, pdf_dir)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending),
                     act["act_number"], "ok" if ok else "FAIL")
            time.sleep(CRAWL_DELAY)

    elif do_extract:
        want    = ["downloaded"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[extract]  %d PDFs to process", len(pending))
        converter = build_converter()
        for i, act in enumerate(pending, 1):
            ok = extract_one(conn, converter, act)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending),
                     act["act_number"], "ok" if ok else "FAIL")
            if ok and act.get("pdf_path"):
                try:
                    Path(act["pdf_path"]).unlink(missing_ok=True)
                except Exception:
                    pass

    print_stats(conn)
    conn.close()


if __name__ == "__main__":
    main()
