#!/bin/bash
# Rebuild ada's local-disk tooling after a reboot wipes /tmp, then start English extraction.
#   bash ~/sllaw/etl/ada_setup.sh            # in tmux; log: ~/sllaw/logs/ada_setup.log
# /tmp/e19309 holds only tools, never data (data streams R2 -> memory -> R2/Neon):
#   sllaw_venv  requirements.txt: docling + Surya OCR (extract), graph
#   hf, cache   model weights and caches                  pip_cache
# Env: WORKERS (default 3: one per card); GPU to pin all workers to one card (default: own card each, freest first).
# Scanned pages are OCR'd by Surya inside docling (replaced Chandra and its vLLM server, 2026-10-06).
set -euxo pipefail
T=/tmp/e19309; R=~/sllaw
mkdir -p $T/hf $T/pip_cache $T/cache $R/logs
export PIP_CACHE_DIR=$T/pip_cache HF_HOME=$T/hf XDG_CACHE_HOME=$T/cache
# caches some tools write under ~/.cache regardless (NFS home: slow enough to stall docling and torch)
for d in torch docling; do
    [ -L ~/.cache/$d ] || { [ -e ~/.cache/$d ] && mv ~/.cache/$d ~/.cache/$d.old.$$ && (rm -rf ~/.cache/$d.old.$$ &); mkdir -p $T/cache/$d; ln -s $T/cache/$d ~/.cache/$d; }
done

# "built" = its packages import; a venv folder alone may be an interrupted install
$T/sllaw_venv/bin/python -c "import docling, docling_surya, boto3, psycopg2" 2>/dev/null || {
    rm -rf $T/sllaw_venv; /usr/bin/python3.12 -m venv $T/sllaw_venv
    $T/sllaw_venv/bin/pip install -q --upgrade pip
    $T/sllaw_venv/bin/pip install -q -r $R/requirements.txt; }

# cards from freest to busiest: lowest load, then most free memory (the cards are shared; 2026-10-06)
# A card needs >= 6 GB free (Surya + docling's layout model); with none, the freest by memory is used.
GPUS=($(nvidia-smi --query-gpu=index,utilization.gpu,memory.free --format=csv,noheader,nounits |
        awk -F', ' '$3 >= 6000' | sort -t, -k2,2n -k3,3nr | cut -d, -f1))
[ ${#GPUS[@]} -gt 0 ] || GPUS=($(nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits |
                                 sort -t, -k2,2nr | head -1 | cut -d, -f1))

# extraction workers (English): each takes its share of the queue and a card of its own, freest first
# torch otherwise starts one thread per core (64) in every worker; on a CPU already loaded ~72/64 by
# other users they just wait on each other (futex_wait, 2026-10-06)
N=${WORKERS:-3}; S=$(date +%Y%m%d_%H%M); THREADS=${THREADS:-8}
for i in $(seq 0 $((N - 1))); do
    G=${GPU:-${GPUS[$((i % ${#GPUS[@]}))]}}
    tmux has-session -t extract$i 2>/dev/null || tmux new-session -d -s extract$i \
        "cd $R && CUDA_VISIBLE_DEVICES=$G HF_HOME=$T/hf XDG_CACHE_HOME=$T/cache OMP_NUM_THREADS=$THREADS MKL_NUM_THREADS=$THREADS $T/sllaw_venv/bin/python -u -m etl.extract --lang ENGLISH --shard $i/$N/$S > logs/extract_${S}_s$i.log 2>&1"
    echo "worker $i on GPU $G"
done
echo SETUP_DONE
