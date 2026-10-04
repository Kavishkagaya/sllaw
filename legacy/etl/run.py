#!/usr/bin/env python3
"""Orchestrator: resource on disk -> chunks in the database.

    probe -> parse -> qa -> persist

QA gates indexing: a document that fails becomes a review item rather than a
silent gap in the corpus, so nothing half-extracted is ever indexed.

    python3 etl/run.py --manifest corpus/manifest.jsonl        # acts (pdf)
    python3 etl/run.py --html 'downloads/*.html' --source consolidated
    python3 etl/run.py --manifest corpus/manifest.jsonl --dry-run

Status: discovered -> chunked -> qa_pass | qa_flagged | ocr_pending | error
"""
import argparse, glob, json, os, sys

from etl import qa
from etl.parse import pdf, html


def probe(path):
    """digital | scanned. The only thing separating the two pipelines."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path)
    pages = [doc[i].get_textpage().get_text_range() for i in range(len(doc))]
    sample = pages[::max(1, len(pages) // 8)][:8]
    cpp = sum(len(p.strip()) for p in sample) / max(1, len(sample))
    return ("digital" if cpp > 200 else "scanned"), pages


def sweep(rec, keep=False):
    """Drop the PDF once it has passed QA. A flagged or scanned document keeps
    its file — that is the copy a human or the OCR path needs. Anything deleted
    is re-fetchable: the spider resumes, so re-parsing costs a download."""
    if keep or rec["kind"] != "pdf" or rec["status"] != "qa_pass" or not rec["pdf_path"]:
        return rec
    try:
        os.remove(rec["pdf_path"])
        rec["pdf_path"] = None
    except OSError:
        pass
    return rec


def process(path, source, kind, source_url=None, meta=None):
    """One document, all the way to a persistable record.

    QA never stops the parse. Every document runs end to end and is flagged;
    a scanned PDF is still parsed for whatever thin text layer it has, and a
    crash mid-parse keeps the chunks produced up to that point. Status records
    what happened; it never decides whether work is attempted.
    """
    rec = {"source": source, "source_url": source_url or path, "kind": kind,
           "pdf_path": path if kind == "pdf" else None, "meta": meta or {},
           "status": "discovered", "chunks": [], "qa": None, "title": None}
    chunks, pages, raw, scanned, skip = [], None, "", False, []
    try:
        if kind == "pdf":
            state, pages = probe(path)
            scanned = state == "scanned"
            chunks = pdf.parse(path)
            raw = "\n".join(pages)
            from etl.parse import layout
            skip = [i + 1 for i, t in enumerate(pages) if layout.is_toc_page(t)]
        else:
            body = open(path, encoding="utf8", errors="replace").read()
            chunks, raw = html.parse(body), html.text(body)
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"

    rec["chunks"] = chunks
    rec["title"] = chunks[0]["breadcrumb"].split(" \u203a ")[0] if chunks else None
    try:
        rec["qa"] = qa.report(chunks, raw, pages, skip)
    except Exception as e:
        rec["qa"] = {"ok": False, "flags": [f"qa_error:{type(e).__name__}"]}
    if rec.get("error"):
        rec["qa"]["flags"] = list(rec["qa"].get("flags", [])) + ["parse_error"]

    # ponytail: no OCR engine yet. Scanned documents still parse and store
    # whatever text layer exists; ocr_pending marks them for the second pass.
    rec["status"] = ("ocr_pending" if scanned
                     else "qa_pass" if rec["qa"].get("ok") else "qa_flagged")
    return rec


def done_urls(conn):
    """Documents already chunked, so a restart resumes instead of redoing."""
    with conn.cursor() as cur:
        cur.execute("SELECT source_url FROM documents WHERE status='qa_pass'")
        return {r[0] for r in cur.fetchall()}


def persist(conn, rec):
    """Upsert the document, then replace its chunks wholesale — re-running a
    document is idempotent, which is what makes QA re-runs safe."""
    from psycopg2.extras import execute_values
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO documents (source, source_url, kind, title, pdf_path, meta,
                                   qa, chunks_count, status, error, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (source, source_url) DO UPDATE SET
                title=EXCLUDED.title, pdf_path=EXCLUDED.pdf_path, meta=EXCLUDED.meta,
                qa=EXCLUDED.qa, chunks_count=EXCLUDED.chunks_count,
                status=EXCLUDED.status, error=EXCLUDED.error, updated_at=NOW()
            RETURNING id""",
            (rec["source"], rec["source_url"], rec["kind"], rec["title"], rec["pdf_path"],
             json.dumps(rec["meta"]), json.dumps(rec["qa"]), len(rec["chunks"]),
             rec["status"], rec.get("error")))
        doc_id = cur.fetchone()[0]
        cur.execute("DELETE FROM chunks WHERE document_id=%s", (doc_id,))
        # one round trip, not one per chunk: the database is in us-east-1 and a
        # single INSERT costs ~380ms of latency, which dwarfs everything else
        execute_values(cur, """
            INSERT INTO chunks (document_id, idx, kind, anchor, part, chapter,
                                note, pages, breadcrumb, text) VALUES %s""",
            [(doc_id, c["idx"], c["kind"], c["anchor"], c["part"], c["chapter"],
              c["note"], c["pages"], c["breadcrumb"], c["text"]) for c in rec["chunks"]])
    conn.commit()
    return doc_id


def connect():
    import psycopg2
    from dotenv import load_dotenv
    load_dotenv()
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set. Add it to .env, or pass --dry-run.")
    return psycopg2.connect(url)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--manifest", help="manifest.jsonl from the spider (pdf documents)")
    a.add_argument("--crawl", action="store_true",
                   help="crawl and process each act as it downloads, instead of "
                        "downloading everything first")
    a.add_argument("--pdf-dir", default="corpus", help="where --crawl puts PDFs")
    a.add_argument("--search", help="--crawl only: restrict to a search query")
    a.add_argument("--html", help="glob of html documents")
    a.add_argument("--source", default="acts")
    a.add_argument("--dry-run", action="store_true", help="write JSON to --out, no database")
    a.add_argument("--keep-pdfs", action="store_true",
                   help="keep every PDF; default deletes those that pass QA")
    a.add_argument("--out", default="run_out")
    args = a.parse_args()

    def crawled():
        """Download one act, hand it straight to the parser, delete it, move on.
        Keeps peak disk at a handful of files and lands rows continuously
        instead of after every download finishes."""
        from etl.spiders import acts as spider
        os.makedirs(args.pdf_dir, exist_ok=True)
        for rec in spider.crawl(args.search):
            m = spider.fetch(rec, args.pdf_dir)
            if not m["path"]:
                print(f"{str(m['act_no']):>10}  skipped: no ENGLISH pdf", flush=True)
                continue
            yield (m["path"], "pdf", m["source_url"],
                   {k: m[k] for k in ("act_no", "date", "description") if m.get(k)})

    jobs = []
    if args.crawl:
        jobs = crawled()
    elif args.manifest:
        base = os.path.dirname(os.path.abspath(args.manifest))
        for line in open(args.manifest):
            m = json.loads(line)
            if m.get("path"):
                # manifest paths are relative to wherever the spider ran, so
                # resolve them against the manifest itself
                path = m["path"] if os.path.exists(m["path"]) else \
                    os.path.join(base, os.path.basename(m["path"]))
                jobs.append((path, "pdf", m.get("source_url"),
                             {k: m[k] for k in ("act_no", "date", "description") if m.get(k)}))
    if args.html:
        jobs = list(jobs) + [(p, "html", p, {}) for p in sorted(glob.glob(args.html))]
    if not jobs:
        sys.exit("nothing to do — pass --crawl, --manifest or --html")

    conn = None if args.dry_run else connect()
    seen = done_urls(conn) if conn else set()
    if args.dry_run:
        os.makedirs(args.out, exist_ok=True)
    counts = {}
    for path, kind, url, meta in jobs:
        if url in seen:
            counts["skipped"] = counts.get("skipped", 0) + 1
            continue
        rec = process(path, args.source, kind, url, meta)
        counts[rec["status"]] = counts.get(rec["status"], 0) + 1
        if conn:
            persist(conn, sweep(rec, args.keep_pdfs))
        else:
            json.dump(rec, open(os.path.join(args.out, os.path.basename(path) + ".json"), "w"),
                      indent=1, ensure_ascii=False)
        flags = ",".join((rec["qa"] or {}).get("flags", [])) or rec.get("error", "")
        print(f"{os.path.basename(path)[:28]:28} {rec['status']:12} "
              f"{len(rec['chunks']):>5} chunks  {flags}", flush=True)
    print("\n" + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
