#!/usr/bin/env python3
"""
migrate.py — SQL migration runner

Applies pending migrations from migrations/ in filename order.
Tracks applied migrations in a schema_migrations table.

Local usage:
  .venv/bin/python3 etl/migrate.py

On ada:
  ~/miniconda3/envs/sllaw/bin/python etl/migrate.py

Flags:
  --status   show applied / pending without running anything
"""

import logging
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("migrate")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def get_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL not set. Add it to .env or export it.")
    return psycopg2.connect(url)


def bootstrap(conn):
    with conn.cursor() as cur:
        cur.execute(BOOTSTRAP)
    conn.commit()


def applied(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
        return {row[0] for row in cur.fetchall()}


def pending(conn):
    done = applied(conn)
    return sorted(f for f in MIGRATIONS_DIR.glob("*.sql") if f.name not in done)


def run_migration(conn, path):
    sql = path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute(
            "INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,)
        )
    conn.commit()


def main():
    show_status = "--status" in sys.argv

    conn = get_conn()
    bootstrap(conn)

    if show_status:
        done    = applied(conn)
        all_sql = sorted(f.name for f in MIGRATIONS_DIR.glob("*.sql"))
        log.info("%-40s  %s", "FILE", "STATUS")
        log.info("-" * 50)
        for name in all_sql:
            log.info("%-40s  %s", name, "applied" if name in done else "pending")
        conn.close()
        return

    todo = pending(conn)
    if not todo:
        log.info("Nothing to migrate — all migrations already applied.")
        conn.close()
        return

    for path in todo:
        log.info("Applying %s ...", path.name)
        try:
            run_migration(conn, path)
            log.info("  → ok")
        except Exception as exc:
            conn.rollback()
            log.error("  → FAILED: %s", exc)
            conn.close()
            sys.exit(1)

    conn.close()
    log.info("%d migration(s) applied.", len(todo))


if __name__ == "__main__":
    main()
