#!/bin/bash
# The documents pipeline on ada, end to end (2026-10-10): LightOn on every PDF without it, then docs + chunks + links.
#   CARDS="1 2" SHAS=logs/ocr_all.txt bash ~/sllaw/etl/docs_ada.sh     # in tmux; log ~/sllaw/logs/docs_ada_<time>.log
# SHAS: sha256s to OCR (every page), one a line; empty or missing = skip OCR. Waits for the OCR workers by their
# tmux sessions (not pgrep: it matches its own command line, PIPELINE.md), then stops the servers.
set -u
T=/var/tmp/e19309; R=~/sllaw; cd $R
# the project database is the Postgres on ada (etl/db_ada.sh), not Neon (2026-10-10)
export DATABASE_URL=$(grep '^DB_LOCAL_URL=' .env | cut -d= -f2-)
bash etl/db_ada.sh >/dev/null
read -ra C <<< "${CARDS:-1 2}"
if [ -s "${SHAS:-}" ]; then
    CARDS="${C[*]}" bash etl/ocr_ada.sh
    for s in 0 1; do
        P=$((8013 + s))
        for w in 0 1; do
            i=$((2 * s + w))
            tmux new-session -d -s ocrall$i "until curl -sf localhost:$P/health; do sleep 5; done; \
                $T/lighton_venv/bin/python -u -m etl.ocr --api http://localhost:$P/v1 --sha $SHAS --shard $i/4 > logs/ocr_all_w$i.log 2>&1"
        done
    done
    sleep 60
    while tmux ls 2>/dev/null | grep -q '^ocrall'; do sleep 60; done
    for s in ocr_srv0 ocr_srv1 ocr0 ocr1 ocr2 ocr3; do tmux kill-session -t $s 2>/dev/null; done
    done_n=$(cat logs/ocr_all_w*.log | grep -c 'pages in'); want=$(grep -c . "$SHAS")
    echo "OCR done: $done_n of $want files, $(cat logs/ocr_all_w*.log | grep -c FAIL) failed"
    # don't build on a half-done OCR (all four workers once died at start on a DNS failure, 2026-10-10)
    if [ $((done_n * 100)) -lt $((want * 95)) ]; then echo "PIPELINE_STOPPED: OCR incomplete"; exit 1; fi
fi
$T/lighton_venv/bin/python -u -m etl.docs build --workers 12
$T/lighton_venv/bin/python -u -m etl.docs links
echo PIPELINE_DONE
