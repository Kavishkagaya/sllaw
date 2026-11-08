#!/bin/bash
# bash etl/v2/all.sh [workers] -- the v2 pipeline end to end on this host, no workflow engine: every stage is plan, then
# N workers (they share the state DB and claim items, so more hosts can join with `python -m etl.v2.run work <stage>`).
#   1 listing   every spider (etl/v2/stages.py SPIDERS); a site that fails keeps its last listing
#   2 fetch     the file each document needs that R2 does not hold yet (stage 2's choice)
#   3 extract   files with no raw output yet (docling: sllaw_venv; English scans need an OCR server in V2_OCR_API)
#   4-5 build   tree, chunks, R2 parts, issues;  6 links + resolve;  then the link gold set, the publish and embed
#   dry runs and the full quality gate. Rerunnable: each plan finds only what is new or changed.
# Env: /var/tmp/e19309/v2.env (V2_DATABASE_URL, V2_R2_PREFIX) and ~/sllaw/.env. Run it in tmux; stop it with
# `tmux kill-session -t v2all` (Ctrl-C in the pane is ignored).
set -u
trap "" INT
cd ~/sllaw
export $(cat /var/tmp/e19309/v2.env)
# where R2 output goes must be said, never defaulted: "" is production, "v2test/" a trial (2026-11-07: a trial run
# without it wrote 4,904 objects at the bucket root)
if ! grep -q '^V2_R2_PREFIX=' /var/tmp/e19309/v2.env; then echo "V2_R2_PREFIX missing from v2.env" >&2; exit 1; fi
P=/var/tmp/e19309/etl_venv/bin/python
PX=/var/tmp/e19309/sllaw_venv/bin/python     # docling
N=${1:-12}
LOG=~/sllaw/logs/v2
mkdir -p "$LOG"
step() { echo "$(date '+%F %T') $*" | tee -a "$LOG/all.log"; }
stage() {   # stage <name> <python> <workers>
  step "plan $1"; $2 -m etl.v2.run plan $1 >> "$LOG/all.log" 2>&1
  for i in $(seq 1 "$3"); do $2 -u -m etl.v2.run work $1 --n 2 > "$LOG/$1.$i.log" 2>&1 & done
  wait
  step "$1 done"; $P -m etl.v2.run status >> "$LOG/all.log" 2>&1
}

step "listing";         $P -u -m etl.v2.run listing all >> "$LOG/all.log" 2>&1
stage fetch   "$P"  4
stage extract "$PX" 4
stage build   "$P"  "$N"
stage links   "$P"  "$N"
step resolve;           $P -u -m etl.v2.run resolve    >> "$LOG/all.log" 2>&1
step gold-links;        $P -u -m etl.v2.run gold-links >> "$LOG/all.log" 2>&1
step "publish dry run"; $P -u -m etl.v2.run publish    >> "$LOG/all.log" 2>&1
step "embed dry run";   $P -u -m etl.v2.run embed      >> "$LOG/all.log" 2>&1
step gate;              $P -u -m etl.v2.gate --workers 8 > "$LOG/gate.log" 2>&1
step "all done"; $P -m etl.v2.run status >> "$LOG/all.log" 2>&1
