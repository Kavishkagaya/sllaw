#!/usr/bin/env python3
"""
spider.py — Consolidated Statutes Spider

Supports multiple collections from lankalaw.net:
  2006  — https://lankalaw.net/legislative-enactments/consolidated-statutes-upto-2006/
          ~1490 HTML files, statutes up to 2006.
  2024  — https://lankalaw.net/legislations/acts-and-laws/consolidated-acts-2024/
          ~85 HTML files (overlap with 2006) + ~304 new consolidated PDFs.

For HTML statutes: fetches and parses immediately (extract_statute.py).
For PDF statutes:  records source_url, sets status='discovered' (pdf extraction
                   needs a separate docling step, same as the acts spider).

HTML statutes that already exist in the DB under a different collection are
re-used by inserting a second row for the new collection (same content, different
collection tag). Use --skip-html-dupes to skip HTML URLs already known from
any other collection (saves requests).

Local usage:
  .venv/bin/python3 etl/consolidated/spider.py --collection 2006
  .venv/bin/python3 etl/consolidated/spider.py --collection 2024

Flags:
  --collection SLUG  which collection to crawl (required unless --stats)
  --discover-only    only populate consolidated_statutes table
  --extract-only     only parse already-discovered HTML statutes
  --retry-failed     include failed rows in extract phase
  --skip-html-dupes  skip HTML URLs that already exist in another collection
  --stats            print DB status counts for all collections and exit
  --log-file PATH    also write logs to this file
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import psycopg2
import psycopg2.extras
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))
from extract_statute import (
    build_pdf_converter,
    build_document_pdf,
    extract_statute,
    run_docling_pass1,
)

# ── Collections registry ──────────────────────────────────────────────────────

COLLECTIONS = {
    "2006": "https://lankalaw.net/legislative-enactments/consolidated-statutes-upto-2006/",
    "2024": "https://lankalaw.net/legislations/acts-and-laws/consolidated-acts-2024/",
}

CRAWL_DELAY = 1.0

log = logging.getLogger("consolidated-spider")


# ── Logging ───────────────────────────────────────────────────────────────────

def setup_logging(log_file=None):
    fmt     = "%(asctime)s  %(levelname)-7s  %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt=datefmt, handlers=handlers)


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set. Add it to .env or export it.")
    return psycopg2.connect(url)


def fetch_statutes(conn, collection, statuses):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM consolidated_statutes"
            " WHERE collection = %s AND status = ANY(%s)"
            " ORDER BY id",
            (collection, list(statuses)),
        )
        return cur.fetchall()


def known_html_urls(conn) -> set:
    """Return all source_urls already in the DB with source_type='html'."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT source_url FROM consolidated_statutes"
            " WHERE source_type = 'html'"
        )
        return {r[0] for r in cur.fetchall()}


def mark_failed(conn, statute_id, error):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE consolidated_statutes"
            " SET status='failed', error=%s, updated_at=NOW() WHERE id=%s",
            (str(error)[:500], statute_id),
        )
    conn.commit()


def print_stats(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT collection, source_type, status, COUNT(*)"
            " FROM consolidated_statutes"
            " GROUP BY collection, source_type, status"
            " ORDER BY collection, source_type, status"
        )
        rows = cur.fetchall()
    log.info("── DB status ──────────────────────────────────────────")
    if not rows:
        log.info("  (empty)")
        return
    for collection, stype, status, count in rows:
        log.info("  %-8s  %-5s  %-12s  %5d", collection, stype, status, count)


# ── Phase 1 — Discovery ───────────────────────────────────────────────────────

def _html_code(url: str) -> str | None:
    stem = Path(urlparse(url).path).stem
    return stem if stem else None


def _source_type(url: str) -> str:
    return "pdf" if url.lower().endswith(".pdf") else "html"


def discover(conn, session, collection: str, index_url: str,
             skip_html_dupes: bool = False) -> tuple[int, int]:
    """
    Fetch index page, parse all statute links, upsert into consolidated_statutes.
    Returns (inserted, total).
    """
    resp = session.get(index_url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    links = [
        a for a in soup.find_all("a", href=True)
        if "/wp-content/uploads/" in a["href"]
        and (a["href"].endswith(".html") or a["href"].endswith(".pdf"))
    ]

    existing_html = known_html_urls(conn) if skip_html_dupes else set()

    inserted = 0
    with conn.cursor() as cur:
        for a in links:
            url         = urljoin(index_url, a["href"])
            stype       = _source_type(url)
            index_title = a.get_text(strip=True)
            is_repealed = "(repealed)" in index_title.lower()
            code        = _html_code(url) if stype == "html" else None

            if skip_html_dupes and stype == "html" and url in existing_html:
                continue

            cur.execute(
                """
                INSERT INTO consolidated_statutes
                    (collection, source_url, source_type, html_code,
                     index_title, is_repealed)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (collection, source_url) DO NOTHING
                RETURNING id
                """,
                (collection, url, stype, code, index_title, is_repealed),
            )
            if cur.fetchone():
                inserted += 1

    conn.commit()
    return inserted, len(links)


# ── Phase 2a — Fetch & Extract HTML ──────────────────────────────────────────

def extract_one(conn, session, statute) -> bool:
    statute_id = statute["id"]
    url        = statute["source_url"]

    try:
        resp = session.get(url, timeout=120)
        resp.raise_for_status()
        data = extract_statute(resp.text)
    except Exception as exc:
        mark_failed(conn, statute_id, f"fetch/parse: {exc}")
        return False

    parts    = data["parts"]
    sections = data["sections"]

    doc = {
        "title":        data["title"],
        "description":  data["description"],
        "enacted_date": data["enacted_date"],
        "is_repealed":  data["is_repealed"],
        "source_url":   url,
        "parts":        parts,
        "sections":     sections,
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
                    raw_json       = %s,
                    status         = 'extracted',
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
                    (
                        statute_id,
                        p["number"],
                        p.get("title", ""),
                        p.get("sections", []),
                        p.get("type", "part"),
                    ),
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
                    (
                        statute_id,
                        num_str,
                        s.get("short_title"),
                        s.get("part"),
                        s.get("body", ""),
                    ),
                )

        conn.commit()

    except Exception as exc:
        conn.rollback()
        mark_failed(conn, statute_id, f"db write: {exc}")
        return False

    return True


# ── Phase 2b — Download & Extract PDF (two-pass) ─────────────────────────────

def _download_pdf(session, url: str, dest: Path) -> bool:
    try:
        resp = session.get(url, timeout=60)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        return True
    except Exception:
        return False


def extract_pass1_pdf(conn, session, converter, statute, pdf_dir: Path) -> bool:
    """Pass 1: download PDF, run docling, store docling_json → status docling_done."""
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
        mark_failed(conn, statute_id, f"db write pass1: {exc}")
        dest.unlink(missing_ok=True)
        return False

    dest.unlink(missing_ok=True)
    return True


def extract_pass2(conn, statute) -> bool:
    """Pass 2: build structured doc from stored docling_json → status extracted/flagged."""
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
        mark_failed(conn, statute_id, f"db write pass2: {exc}")
        return False

    if stopped and flags:
        log.warning("  [flagged] %s  flags: %s",
                    statute["source_url"].split("/")[-1], flags[:3])
    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Consolidated Statutes Spider")
    p.add_argument("--collection",
                   choices=list(COLLECTIONS),
                   help=f"Which collection to crawl: {list(COLLECTIONS)}")
    p.add_argument("--discover-only",    action="store_true")
    p.add_argument("--extract-only",     action="store_true")
    p.add_argument("--build-only",       action="store_true",
                   help="Run pass 2 only (structure build) on docling_done and flagged PDFs")
    p.add_argument("--retry-failed",     action="store_true")
    p.add_argument("--skip-html-dupes",  action="store_true",
                   help="Skip HTML URLs already indexed from any other collection")
    p.add_argument("--pdf-dir",
                   default=os.environ.get("PDF_DIR", "pdfs"),
                   help="Directory for temporary PDF downloads (default: ./pdfs or $PDF_DIR)")
    p.add_argument("--stats",            action="store_true",
                   help="Print DB status counts and exit")
    p.add_argument("--log-file",         default=None)
    return p.parse_args()


def main():
    args = parse_args()
    setup_logging(args.log_file)

    conn    = get_conn()
    session = requests.Session()
    session.headers["User-Agent"] = "sllaw-spider/1.0 (legal research, non-commercial)"

    if args.stats:
        print_stats(conn)
        conn.close()
        return

    if not args.collection and not args.build_only:
        log.error("--collection is required (choices: %s)", list(COLLECTIONS))
        conn.close()
        sys.exit(1)

    collection = args.collection or ""
    index_url  = COLLECTIONS.get(collection, "")
    pdf_dir    = Path(args.pdf_dir).expanduser().resolve()
    pdf_dir.mkdir(parents=True, exist_ok=True)

    do_discover = not args.extract_only and not args.build_only
    do_extract  = not args.discover_only

    # ── Phase 1: Discovery ────────────────────────────────────────────────────
    if do_discover and collection and index_url:
        log.info("[discover] collection=%s  index=%s", collection, index_url)
        try:
            inserted, total = discover(
                conn, session, collection, index_url,
                skip_html_dupes=args.skip_html_dupes,
            )
            log.info("  %d links found, %d new", total, inserted)
        except Exception as exc:
            log.error("  discovery FAILED: %s", exc)
            conn.close()
            sys.exit(1)

    # ── Phase 2a: Fetch & Extract HTML statutes ───────────────────────────────
    if do_extract and collection:
        want = ["discovered"] + (["failed"] if args.retry_failed else [])

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM consolidated_statutes"
                " WHERE collection = %s AND source_type = 'html'"
                " AND status = ANY(%s) ORDER BY id",
                (collection, want),
            )
            html_pending = cur.fetchall()

        log.info("[extract-html] %d HTML statutes to process", len(html_pending))
        for i, statute in enumerate(html_pending, 1):
            ok = extract_one(conn, session, statute)
            log.info(
                "  [%4d/%d] %-35s  %s",
                i, len(html_pending),
                statute["html_code"] or statute["source_url"][-40:],
                "ok" if ok else "FAIL",
            )
            time.sleep(CRAWL_DELAY)

    # ── Phase 2b: Pass 1 — Download & run docling on PDFs ────────────────────
    if do_extract and not args.build_only and collection:
        want = ["discovered"] + (["failed"] if args.retry_failed else [])

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM consolidated_statutes"
                " WHERE collection = %s AND source_type = 'pdf'"
                " AND status = ANY(%s) ORDER BY id",
                (collection, want),
            )
            pdf_pending = cur.fetchall()

        if pdf_pending:
            log.info("[pass1-pdf] %d PDF statutes  → %s", len(pdf_pending), pdf_dir)
            converter = build_pdf_converter()
            for i, statute in enumerate(pdf_pending, 1):
                ok = extract_pass1_pdf(conn, session, converter, statute, pdf_dir)
                log.info(
                    "  [%4d/%d] %-45s  %s",
                    i, len(pdf_pending),
                    statute["source_url"].split("/")[-1],
                    "pass1-ok" if ok else "FAIL",
                )

    # ── Phase 2c: Pass 2 — Build structure from docling_json ─────────────────
    if do_extract or args.build_only:
        want2 = ["docling_done", "flagged"]
        if collection:
            q2      = ("SELECT * FROM consolidated_statutes"
                       " WHERE collection = %s AND source_type = 'pdf'"
                       " AND status = ANY(%s) ORDER BY id")
            params2 = (collection, want2)
        else:
            q2      = ("SELECT * FROM consolidated_statutes"
                       " WHERE source_type = 'pdf'"
                       " AND status = ANY(%s) ORDER BY id")
            params2 = (want2,)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(q2, params2)
            build_pending = cur.fetchall()

        if build_pending:
            log.info("[pass2-build] %d PDF statutes to structure", len(build_pending))
            for i, statute in enumerate(build_pending, 1):
                ok = extract_pass2(conn, statute)
                log.info(
                    "  [%4d/%d] %-45s  %s",
                    i, len(build_pending),
                    statute["source_url"].split("/")[-1],
                    "ok" if ok else "FAIL",
                )

    print_stats(conn)
    conn.close()


if __name__ == "__main__":
    main()
