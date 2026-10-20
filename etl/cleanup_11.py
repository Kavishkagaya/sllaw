"""Issue #11, one-off (2026-10-20): drop lankalaw/CommonLII `documents` rows no law is built from (an official file of
the same law is used and the titles match), then their R2 objects (source, raw/v2, raw/lighton) no remaining row shares.
  python -m etl.backup documents && python etl/cleanup_11.py ids.txt      # on the work host; ids one per line
Logs every R2 key deleted to logs/cleanup_r2_<date>.txt."""
import os, sys
sys.path.insert(0, os.path.expanduser("~/sllaw"))
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/sllaw/.env"))
import psycopg2
from etl.fetch import r2

ids = [int(x) for x in open(sys.argv[1]) if x.strip()]
conn = psycopg2.connect(os.environ["DB_LOCAL_URL"])
cur = conn.cursor()
for t in ("acts", "docs"):        # nothing built from them
    cur.execute(f"SELECT count(*) FROM {t} WHERE document_id = ANY(%s)", (ids,))
    assert cur.fetchone()[0] == 0, t
cur.execute("SELECT DISTINCT sha256, r2_key, raw_key FROM documents WHERE id = ANY(%s)", (ids,))
files = cur.fetchall()
cur.execute("DELETE FROM documents WHERE id = ANY(%s)", (ids,))
print("rows deleted", cur.rowcount)
cur.execute("SELECT sha256, r2_key, raw_key FROM documents")
keep_sha, keep_keys = set(), set()
for sha, a, b in cur.fetchall():
    keep_sha.add(sha)
    keep_keys |= {a, b}
conn.commit()
keys = sorted({k for sha, a, b in files if sha not in keep_sha
               for k in (a, b, f"raw/lighton/{sha}.json.gz") if k and k not in keep_keys})
s3, bucket, n = r2(), os.environ["R2_BUCKET"], 0
with open(os.path.expanduser("~/sllaw/logs/cleanup_r2_20261020.txt"), "w") as log:
    for i in range(0, len(keys), 1000):
        batch = keys[i:i + 1000]
        r = s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True})
        assert not r.get("Errors"), r["Errors"][:3]
        log.write("\n".join(batch) + "\n")
        n += len(batch)
print("unshared files", len({f[0] for f in files} - keep_sha), "R2 keys deleted", n)
