#!/usr/bin/env python3
"""Back up Neon tables to R2 as gzipped CSV (COPY, so no pg_dump version to match), then read each back to check.

  python3 -m etl.backup documents [docs chunks links ...]   # -> backups/<table>_<UTC time>.csv.gz in R2

`documents` is the one table nothing rebuilds (listing records, R2 keys, sha256s); the rest come from R2 raws and
the code. Restore: CREATE the table from etl/migrations, then COPY <table> FROM STDIN WITH (FORMAT csv, HEADER).
"""
import csv, gzip, io, os, sys
from datetime import datetime, timezone

from dotenv import load_dotenv

from etl.fetch import pg_connect, r2

load_dotenv()


def backup(table):
    conn = pg_connect()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz, conn.cursor() as cur:
        w = io.TextIOWrapper(gz, encoding="utf-8")
        cur.copy_expert(f"COPY {table} TO STDOUT WITH (FORMAT csv, HEADER)", w)
        w.flush()
        cur.execute(f"SELECT count(*) FROM {table}")
        n = cur.fetchone()[0]
    conn.close()
    key = f"backups/{table}_{datetime.now(timezone.utc):%Y%m%d_%H%M}.csv.gz"
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    s3.put_object(Bucket=bucket, Key=key, Body=buf.getvalue(), ContentType="application/gzip")
    # check: read it back and count rows
    back = gzip.decompress(s3.get_object(Bucket=bucket, Key=key)["Body"].read()).decode("utf-8")
    rows = sum(1 for _ in csv.reader(io.StringIO(back))) - 1
    ok = rows == n
    print(f"{table}: {n} rows -> r2://{bucket}/{key} ({len(buf.getvalue()) / 1e6:.1f} MB gz), read back {rows} rows: "
          f"{'OK' if ok else 'MISMATCH'}", flush=True)
    return ok


if __name__ == "__main__":
    sys.exit(0 if all(backup(t) for t in (sys.argv[1:] or ["documents"])) else 1)
