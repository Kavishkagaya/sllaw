#!/bin/bash
# Rebuild a few documents end to end on the work host: docs + chunks + links, gold check, publish, embed.
#   KEYS=cap:25,cap:26 bash ~/sllaw/etl/rebuild_ada.sh      # in tmux; log ~/sllaw/logs/rebuild_<time>.log
# One build worker: parallel workers deadlocked on DELETE FROM docs (its cascade nulls links.dst_chunk), and
# cap:25, cap:26, cap:105, act:7/2007 were left on the old build (2026-10-29). The build ends with links(), which
# re-attaches every link into the rebuilt documents. Publish replaces the app's tables (push-only); embed copies
# the vectors of unchanged text and embeds only the changed chunks (bge-m3 on the freest card, EMBED_LOCAL=1).
# Stops at the first failed step; a gold set below 210/210 stops before publishing.
set -euo pipefail
: "${KEYS:?KEYS=key,key,... required}"
T=/var/tmp/e19309; cd ~/sllaw
export DATABASE_URL=$(grep '^DB_LOCAL_URL=' .env | cut -d= -f2-)
PY=$T/etl_venv/bin/python
bash etl/db_ada.sh >/dev/null
echo "== build $KEYS ($(date '+%F %T'))"
$PY -u -m etl.docs build --keys "$KEYS" --workers 1
$PY -u - "$KEYS" <<'EOF'
import sys
from etl.fetch import pg_connect
keys = sys.argv[1].split(",")
cur = pg_connect().cursor()
cur.execute("""SELECT d.key, d.built_with, count(c.id), max(length(c.text)) FROM docs d LEFT JOIN chunks c ON c.doc_key = d.key
               WHERE d.key = ANY(%s) GROUP BY 1, 2 ORDER BY 1""", (keys,))
rows = cur.fetchall()
for r in rows:
    print("  %s  build %s  %s chunks, longest %s chars" % r)
assert len(rows) == len(keys), f"only {len(rows)} of {len(keys)} documents are in docs"
EOF
echo "== gold"
G=$($PY -u -m etl.docs gold); echo "$G"
grep -q '^total 210/210' <<< "$G" || { echo "REBUILD_STOPPED: gold below 210/210"; exit 1; }
echo "== publish ($(date '+%F %T'))"
$PY -u -m etl.publish
GPU=$(nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits | sort -t, -k2 -nr | head -1 | cut -d, -f1)
echo "== embed on card $GPU ($(date '+%F %T'))"
EMBED_LOCAL=1 HF_HOME=$T/hf CUDA_VISIBLE_DEVICES=$GPU $T/gpu_venv/bin/python -u -m etl.embed
echo "REBUILD_DONE ($(date '+%F %T'))"
