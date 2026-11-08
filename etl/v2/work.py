"""The work queue every stage runs on (docs/PIPELINE_V2.md, "State and workers"), with no workflow engine in it:
any scheduler (cron, Airflow, Dagster, a shell loop) only calls `plan` and starts `work`ers.

  plan(db, stage, items)    items = [(item, fingerprint)]: new or changed items become todo; done ones with the same
                            fingerprint are left alone (that is what makes a rerun redo nothing)
  claim(db, stage, n)       up to n todo items (or running ones whose lease ran out), leased to this worker
  finish / fail             record the result; a failed item is retried by the next claim, up to MAX_TRIES
  singleton(db, name)       a lease row for corpus-wide steps that must run one at a time (link resolution):
                            Postgres advisory locks do not hold through Neon's pooler

Every call is one short transaction: a worker never holds a lock while it works on an item.
"""
import json, os, socket

LEASE = "30 minutes"
MAX_TRIES = 3
WORKER = f"{socket.gethostname()}:{os.getpid()}"


def plan(db, stage, items):
    """Make (stage, item) rows match the items' fingerprints. -> (new or changed, unchanged)."""
    with db.cursor() as cur:
        cur.execute("CREATE TEMP TABLE IF NOT EXISTS _plan (item TEXT PRIMARY KEY, fingerprint TEXT) ON COMMIT DROP")
        cur.execute("TRUNCATE _plan")
        from psycopg2.extras import execute_values
        execute_values(cur, "INSERT INTO _plan VALUES %s ON CONFLICT DO NOTHING", items, page_size=5000)
        cur.execute("""INSERT INTO work (stage, item, fingerprint) SELECT %s, item, fingerprint FROM _plan
                       ON CONFLICT (stage, item) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, status = 'todo',
                         tries = 0, error = NULL, updated_at = NOW()
                       WHERE work.fingerprint <> EXCLUDED.fingerprint""", (stage,))
        changed = cur.rowcount
    db.commit()
    return changed, len(items) - changed


def claim(db, stage, n=1, worker=WORKER):
    """-> [(item, fingerprint)] leased to this worker."""
    with db.cursor() as cur:
        cur.execute(f"""UPDATE work SET status = 'running', lease_by = %s, lease_until = NOW() + INTERVAL '{LEASE}',
                          tries = tries + 1, updated_at = NOW()
                        WHERE (stage, item) IN (
                          SELECT stage, item FROM work
                          WHERE stage = %s AND tries < %s
                            AND (status IN ('todo', 'failed') OR (status = 'running' AND lease_until < NOW()))
                          ORDER BY status = 'failed', item
                          FOR UPDATE SKIP LOCKED LIMIT %s)
                        RETURNING item, fingerprint""", (worker, stage, MAX_TRIES, n))
        out = cur.fetchall()
    db.commit()
    return out


def finish(db, stage, item, fingerprint, output=None, worker=WORKER):
    """Done, unless the item changed while it was worked on (its fingerprint moved on): then it stays todo."""
    with db.cursor() as cur:
        cur.execute("""UPDATE work SET status = 'done', output = %s, error = NULL, lease_by = NULL, lease_until = NULL,
                         updated_at = NOW()
                       WHERE stage = %s AND item = %s AND fingerprint = %s AND lease_by = %s""",
                    (json.dumps(output) if output is not None else None, stage, item, fingerprint, worker))
    db.commit()


def renew(db, stage, item, worker=WORKER):
    """Extend the lease of an item still being worked on (a worker heartbeat: a file can take longer than LEASE)."""
    with db.cursor() as cur:
        cur.execute(f"""UPDATE work SET lease_until = NOW() + INTERVAL '{LEASE}'
                        WHERE stage = %s AND item = %s AND lease_by = %s AND status = 'running'""", (stage, item, worker))
    db.commit()


def fail(db, stage, item, error, worker=WORKER):
    with db.cursor() as cur:
        cur.execute("""UPDATE work SET status = 'failed', error = %s, lease_by = NULL, lease_until = NULL, updated_at = NOW()
                       WHERE stage = %s AND item = %s AND lease_by = %s""", (str(error)[:2000], stage, item, worker))
    db.commit()


def singleton(db, name, worker=WORKER):
    """Take the lease row for a one-at-a-time step -> True if this worker holds it now."""
    with db.cursor() as cur:
        cur.execute(f"""INSERT INTO work (stage, item, fingerprint, status, lease_by, lease_until)
                        VALUES ('lock', %s, '-', 'running', %s, NOW() + INTERVAL '{LEASE}')
                        ON CONFLICT (stage, item) DO UPDATE SET lease_by = EXCLUDED.lease_by,
                          lease_until = EXCLUDED.lease_until, status = 'running', updated_at = NOW()
                        WHERE work.lease_until IS NULL OR work.lease_until < NOW() OR work.lease_by = EXCLUDED.lease_by
                        RETURNING lease_by""", (name, worker))
        got = cur.fetchone()
    db.commit()
    return bool(got)


def release(db, name, worker=WORKER):
    with db.cursor() as cur:
        cur.execute("UPDATE work SET lease_until = NULL, status = 'done' WHERE stage = 'lock' AND item = %s AND lease_by = %s",
                    (name, worker))
    db.commit()


def status(db, stage=None):
    with db.cursor() as cur:
        cur.execute("""SELECT stage, status, count(*) FROM work WHERE %s::text IS NULL OR stage = %s
                       GROUP BY 1, 2 ORDER BY 1, 2""", (stage, stage))
        return cur.fetchall()
