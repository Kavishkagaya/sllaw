#!/usr/bin/env python3
"""
spider.py — Sri Lanka Legal Acts Spider

Crawls documents.gov.lk/view/act/ for acts from 2006 onwards,
downloads English PDFs, runs the two-pass extraction pipeline,
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
  --extract-only             pass 1 + pass 2 on already-downloaded PDFs (no new downloads)
  --build-only               pass 2 only on acts that already have docling_json (no PDF needed)
  --retry-failed             include failed acts in download/extract/build phases
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
    build_document,
    detect_page_type,
    serialize_clusters,
    serialize_table,
)

# ── Constants ─────────────────────────────────────────────────────────────────

BASE_URL    = "https://documents.gov.lk/view/act/"
START_YEAR  = 2006
CRAWL_DELAY = 1.5

log = logging.getLogger("spider")


# ── Logging setup ─────────────────────────────────────────────────────────────

def setup_logging(log_file=None):
    fmt      = "%(asctime)s  %(levelname)-7s  %(message)s"
    datefmt  = "%Y-%m-%d %H:%M:%S"
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


def reconnect_if_needed(conn):
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        return conn
    except Exception:
        try:
            conn.close()
        except Exception:
            pass
        log.info("Reconnecting to database...")
        return get_conn()


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


def fetch_acts_missing_docling(conn):
    """Return all acts where docling_json was never stored (old single-pass pipeline)."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM acts WHERE docling_json IS NULL AND pdf_url IS NOT NULL"
            " ORDER BY year, act_number"
        )
        return cur.fetchall()


def _refetch(conn, act_id):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM acts WHERE id = %s", (act_id,))
        return cur.fetchone()


def mark_failed(conn, act_id, error):
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE acts SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
                (str(error)[:500], act_id),
            )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
            conn2 = get_conn()
            with conn2.cursor() as cur:
                cur.execute(
                    "UPDATE acts SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
                    (str(error)[:500], act_id),
                )
            conn2.commit()
            conn2.close()
        except Exception:
            pass


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
        log.info("  %-14s  %5d", status, count)


# ── Phase 1 — Discovery ───────────────────────────────────────────────────────

def discover_year(conn, session, year):
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


# ── Pass 1 — Docling serialisation ───────────────────────────────────────────

def extract_pass1(conn, converter, act):
    """Run docling on the PDF, serialise all cluster data → docling_json.
    Status → 'docling_done'. Does NOT delete the PDF (caller handles that).
    Returns (success, conn) — conn may be a fresh connection if the original
    timed out during the long docling run."""
    act_id   = act["id"]
    pdf_path = Path(act["pdf_path"])

    try:
        result      = converter.convert(str(pdf_path.resolve()))
        total_pages = len(pdfium.PdfDocument(str(pdf_path)))

        pages = []
        for pg_idx in range(total_pages):
            if pg_idx >= len(result.pages):
                break
            clusters = result.pages[pg_idx].predictions.layout.clusters
            ptype    = detect_page_type(clusters)
            pages.append({
                "index":     pg_idx,
                "page_type": ptype,
                "clusters":  serialize_clusters(clusters),
            })

        tables = [serialize_table(t) for t in result.document.tables]
        docling_json = {"total_pages": total_pages, "pages": pages, "tables": tables}

    except Exception as exc:
        mark_failed(conn, act_id, f"docling: {exc}")
        return False, conn

    # Reconnect before writing — the DB connection may have timed out during
    # a long docling run (some PDFs take 3+ minutes to process).
    conn = reconnect_if_needed(conn)

    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE acts SET docling_json=%s, status='docling_done', error=NULL,"
                " updated_at=NOW() WHERE id=%s",
                (json.dumps(docling_json), act_id),
            )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        mark_failed(conn, act_id, f"db write pass1: {exc}")
        return False, conn

    return True, conn


# ── Pass 2 — Document build ───────────────────────────────────────────────────

def extract_pass2(conn, act):
    """Build doc_json from docling_json (no PDF needed).
    Status → 'extracted'. Collision sections are stored under composite keys and flagged."""
    act_id       = act["id"]
    docling_json = act.get("docling_json")
    if not docling_json:
        mark_failed(conn, act_id, "pass2: no docling_json")
        return False

    try:
        doc = build_document(docling_json)
    except Exception as exc:
        mark_failed(conn, act_id, f"pass2: {exc}")
        return False

    final_status = 'flagged' if doc.get("stopped") else 'extracted'

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
        mark_failed(conn, act_id, f"db write pass2: {exc}")
        return False

    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p   = argparse.ArgumentParser(description="Sri Lanka Legal Acts Spider")
    p.add_argument("--act-id",  type=int, default=None, help="Process a single act by DB id (full pipeline)")
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--year",  type=int, help="Single year, e.g. --year 2024")
    grp.add_argument("--years", type=str, help="Range, e.g. --years 2010-2015")
    p.add_argument("--pdf-dir",       default=os.environ.get("PDF_DIR", "pdfs"))
    p.add_argument("--log-file",      default=None)
    p.add_argument("--discover-only", action="store_true")
    p.add_argument("--download-only", action="store_true")
    p.add_argument("--extract-only",  action="store_true",
                   help="Pass 1 + Pass 2 on already-downloaded PDFs")
    p.add_argument("--build-only",    action="store_true",
                   help="Pass 2 only: rebuild doc_json from existing docling_json (no PDF)")
    p.add_argument("--ocr",           action="store_true", help="Enable OCR in docling (GPU recommended)")
    p.add_argument("--retry-failed",  action="store_true")
    p.add_argument("--reindex",       action="store_true",
                   help="Re-download + re-docling acts that have no docling_json stored")
    p.add_argument("--stats",         action="store_true")
    return p.parse_args()


def resolve_years(args):
    if args.year:
        return [args.year]
    if args.years:
        lo, hi = args.years.split("-")
        return list(range(int(lo), int(hi) + 1))
    return list(range(START_YEAR, datetime.now().year + 1))


def main():
    args    = parse_args()
    setup_logging(args.log_file)

    pdf_dir = Path(args.pdf_dir).expanduser().resolve()
    conn    = get_conn()

    if args.stats:
        print_stats(conn)
        conn.close()
        return

    if args.act_id:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM acts WHERE id=%s", (args.act_id,))
            act = cur.fetchone()
        if not act:
            sys.exit(f"No act with id={args.act_id}")
        session   = requests.Session()
        session.headers["User-Agent"] = "sllaw-spider/1.0 (legal research, non-commercial)"
        converter = build_converter(ocr=args.ocr)
        pdf_dir   = Path(args.pdf_dir).expanduser().resolve()
        log.info("[act-id] Processing act %s (id=%d)", act["act_number"], act["id"])
        ok = download_pdf(conn, session, act, pdf_dir)
        if not ok:
            sys.exit("Download failed")
        act = _refetch(conn, act["id"])
        ok, conn = extract_pass1(conn, converter, act)
        if not ok:
            sys.exit("Pass 1 failed")
        act = _refetch(conn, act["id"])
        ok = extract_pass2(conn, act)
        if ok and act.get("pdf_path"):
            Path(act["pdf_path"]).unlink(missing_ok=True)
        log.info("Done — %s", "ok" if ok else "pass2 FAIL")
        conn.close()
        return

    years = resolve_years(args)

    do_discover = not (args.download_only or args.extract_only or args.build_only or args.reindex)
    do_download = not (args.discover_only or args.extract_only or args.build_only or args.reindex)
    do_extract  = not (args.discover_only or args.download_only or args.build_only or args.reindex)
    do_build    = args.build_only
    do_reindex  = args.reindex

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

    # ── Phases 2+3: Download → Pass1 → Pass2 → Delete (one act at a time) ────
    if do_download and do_extract:
        want    = ["discovered", "downloaded"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[pipeline] %d acts to process  →  pdf tmp: %s", len(pending), pdf_dir)
        converter = build_converter(ocr=args.ocr)
        for i, act in enumerate(pending, 1):
            conn  = reconnect_if_needed(conn)
            label = act["act_number"]
            try:
                # Download (skip if PDF already on disk from a previous interrupted run)
                if act["status"] != "downloaded":
                    ok = download_pdf(conn, session, act, pdf_dir)
                    if not ok:
                        log.info("  [%4d/%d] %-12s  download FAIL", i, len(pending), label)
                        time.sleep(CRAWL_DELAY)
                        continue
                    act = _refetch(conn, act["id"])
                    time.sleep(CRAWL_DELAY)

                # Pass 1: docling → docling_json
                ok, conn = extract_pass1(conn, converter, act)
                if not ok:
                    log.info("  [%4d/%d] %-12s  pass1 FAIL", i, len(pending), label)
                    continue
                act = _refetch(conn, act["id"])

                # Pass 2: build doc_json
                ok = extract_pass2(conn, act)
                log.info("  [%4d/%d] %-12s  %s", i, len(pending), label,
                         "ok" if ok else "pass2 FAIL")

                # Delete PDF
                if act.get("pdf_path"):
                    try:
                        Path(act["pdf_path"]).unlink(missing_ok=True)
                    except Exception:
                        pass

            except Exception as exc:
                log.error("  [%4d/%d] %-12s  UNCAUGHT: %s", i, len(pending), label, exc)
                conn = reconnect_if_needed(conn)
                mark_failed(conn, act["id"], f"uncaught: {exc}")

    elif do_download:
        want    = ["discovered"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[download] %d PDFs to fetch  →  %s", len(pending), pdf_dir)
        for i, act in enumerate(pending, 1):
            conn = reconnect_if_needed(conn)
            ok   = download_pdf(conn, session, act, pdf_dir)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending),
                     act["act_number"], "ok" if ok else "FAIL")
            time.sleep(CRAWL_DELAY)

    elif do_extract:
        want      = ["downloaded"] + (["failed"] if args.retry_failed else [])
        pending   = list(fetch_acts(conn, want, years))
        log.info("[extract]  %d PDFs to process  (pass1 + pass2)", len(pending))
        converter = build_converter(ocr=args.ocr)
        for i, act in enumerate(pending, 1):
            conn = reconnect_if_needed(conn)

            ok, conn = extract_pass1(conn, converter, act)
            if not ok:
                log.info("  [%4d/%d] %-12s  pass1 FAIL", i, len(pending), act["act_number"])
                continue
            act = _refetch(conn, act["id"])

            ok = extract_pass2(conn, act)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending),
                     act["act_number"], "ok" if ok else "pass2 FAIL")

            if ok and act.get("pdf_path"):
                try:
                    Path(act["pdf_path"]).unlink(missing_ok=True)
                except Exception:
                    pass

    elif do_build:
        want    = ["docling_done", "flagged"] + (["failed"] if args.retry_failed else [])
        pending = list(fetch_acts(conn, want, years))
        log.info("[build]    %d acts to rebuild from docling_json", len(pending))
        for i, act in enumerate(pending, 1):
            conn = reconnect_if_needed(conn)
            ok   = extract_pass2(conn, act)
            log.info("  [%4d/%d] %-12s  %s", i, len(pending),
                     act["act_number"], "ok" if ok else "FAIL")

    elif do_reindex:
        pending = list(fetch_acts_missing_docling(conn))
        log.info("[reindex]  %d acts missing docling_json  →  pdf tmp: %s", len(pending), pdf_dir)
        converter = build_converter(ocr=args.ocr)
        for i, act in enumerate(pending, 1):
            conn  = reconnect_if_needed(conn)
            label = act["act_number"]
            try:
                ok = download_pdf(conn, session, act, pdf_dir)
                if not ok:
                    log.info("  [%4d/%d] %-12s  download FAIL", i, len(pending), label)
                    time.sleep(CRAWL_DELAY)
                    continue
                act = _refetch(conn, act["id"])
                time.sleep(CRAWL_DELAY)

                ok, conn = extract_pass1(conn, converter, act)
                if not ok:
                    log.info("  [%4d/%d] %-12s  pass1 FAIL", i, len(pending), label)
                    continue
                act = _refetch(conn, act["id"])

                ok = extract_pass2(conn, act)
                log.info("  [%4d/%d] %-12s  %s", i, len(pending), label,
                         "ok" if ok else "pass2 FAIL")

                if act.get("pdf_path"):
                    try:
                        Path(act["pdf_path"]).unlink(missing_ok=True)
                    except Exception:
                        pass

            except Exception as exc:
                log.error("  [%4d/%d] %-12s  UNCAUGHT: %s", i, len(pending), label, exc)
                conn = reconnect_if_needed(conn)
                mark_failed(conn, act["id"], f"uncaught: {exc}")

    print_stats(conn)
    conn.close()


if __name__ == "__main__":
    main()
