#!/usr/bin/env python3
"""Publish what the app reads (docs, chunks, links) from the work host's Postgres to the app's Neon project (issue #12),
and `documents`, the file inventory: the one table nothing rebuilds, kept here as its second copy (ada died with the
only current one on 2026-10-18; R2's backup was 8 days old). acts and edges are not copied: etl.structure and etl.graph
rebuild them from R2 in minutes.

  python3 -m etl.publish        # on the work host: DB_LOCAL_URL -> APP_DATABASE_URL, all four tables replaced

Push-only: nothing is read back out of Neon but row counts (egress is what its quota meters). Each run replaces the
tables in one transaction, so the app never sees half a publish. Neon project sllaw-app (round-breeze-91541651),
free tier: 512 MB per branch; the three tables were ~125 MB on 2026-10-16.
"""
import io, os

import psycopg2
from dotenv import load_dotenv

from etl.fetch import pg_connect

load_dotenv()

# Schema as migrations 001 + 003 + 004 + 005, minus docs.document_id's FK (documents is a copy, replaced on its own);
# docs also carries its file's source_url (the official page or PDF the app links to as the source).
SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INT PRIMARY KEY, source TEXT NOT NULL, source_url TEXT NOT NULL, title TEXT, doc_date TEXT,
    meta JSONB NOT NULL DEFAULT '{}', sha256 TEXT, r2_key TEXT, bytes BIGINT, fetched_at TIMESTAMPTZ, raw_key TEXT,
    extracted_at TIMESTAMPTZ, error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, year INT, certified DATE, commenced DATE,
    commencement JSONB, document_id INT, text_from TEXT, built_with TEXT, meta JSONB NOT NULL DEFAULT '{}',
    built_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS chunks (
    id BIGSERIAL PRIMARY KEY, doc_key TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE, seq INT NOT NULL,
    label TEXT, text TEXT NOT NULL, path TEXT, UNIQUE (doc_key, seq));
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS source_url TEXT;
CREATE INDEX IF NOT EXISTS chunks_label_idx ON chunks (doc_key, label);
CREATE TABLE IF NOT EXISTS links (
    id BIGSERIAL PRIMARY KEY, src_doc TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    src_chunk BIGINT REFERENCES chunks(id) ON DELETE SET NULL, kind TEXT NOT NULL, dst_doc TEXT NOT NULL,
    dst_label TEXT, dst_chunk BIGINT REFERENCES chunks(id) ON DELETE SET NULL, date DATE, context TEXT,
    detail JSONB);
CREATE INDEX IF NOT EXISTS links_dst_idx ON links (dst_doc, dst_label);
CREATE INDEX IF NOT EXISTS links_src_idx ON links (src_doc);
"""
TABLES = ("documents", "docs", "chunks", "links")   # FK order
COLS = {"documents": "id, source, source_url, title, doc_date, meta, sha256, r2_key, bytes, fetched_at, raw_key, "
                     "extracted_at, error, created_at, updated_at",
        "docs": "key, kind, title, year, certified, commenced, commencement, document_id, text_from, built_with, "
                "meta, built_at",
        "chunks": "id, doc_key, seq, label, text, path",
        "links": "id, src_doc, src_chunk, kind, dst_doc, dst_label, dst_chunk, date, context, detail"}

SELECT = {t: f"SELECT {c} FROM {t}" for t, c in COLS.items()}
SELECT["docs"] = ("SELECT " + ", ".join(f"docs.{c.strip()}" for c in COLS["docs"].split(",")) +
                  ", x.source_url FROM docs LEFT JOIN documents x ON x.id = docs.document_id")


def main():
    src = psycopg2.connect(os.environ["DB_LOCAL_URL"])
    dst = pg_connect(url=os.environ["APP_DATABASE_URL"])   # retries ada's DNS failures
    with src.cursor() as s, dst.cursor() as d:
        d.execute(SCHEMA)
        d.execute("TRUNCATE links, chunks, docs, documents")
        for t in TABLES:
            # ponytail: whole table in memory (~85 MB for chunks); stream through a pipe if it outgrows ada's RAM
            buf = io.BytesIO()
            s.copy_expert(f"COPY ({SELECT[t]}) TO STDOUT", buf)
            buf.seek(0)
            d.copy_expert(f"COPY {t} ({COLS[t]}{', source_url' if t == 'docs' else ''}) FROM STDIN", buf)
            s.execute(f"SELECT count(*) FROM {t}")
            d.execute(f"SELECT count(*) FROM {t}")
            n_src, n_dst = s.fetchone()[0], d.fetchone()[0]
            assert n_src == n_dst, f"{t}: {n_src} on the work host, {n_dst} in Neon"
            print(f"{t}: {n_dst} rows, {buf.tell() / 1e6:.1f} MB", flush=True)
        for t in ("chunks", "links"):
            d.execute(f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), COALESCE(max(id), 1)) FROM {t}")
    dst.commit()
    with dst.cursor() as d:
        d.execute("ANALYZE documents; ANALYZE docs; ANALYZE chunks; ANALYZE links")
    dst.commit()


if __name__ == "__main__":
    main()
