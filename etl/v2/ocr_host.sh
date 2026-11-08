#!/bin/bash
# bash etl/v2/ocr_host.sh [queues] -- on a host that serves OCR queues for the pipeline (ada: docling + Surya needs
# Python 3.12, which ada's sllaw_venv has). Run it in tmux (`tmux new -d -s v2ocrhost "bash ~/sllaw/etl/v2/ocr_host.sh"`).
# Every 5 minutes: if a queue has files, start one worker on this host's freest GPU; it exits when the queue is
# empty, so an idle host loads no model. The pipeline's ocr op plans the queue and waits for it to drain.
# Env: /var/tmp/e19309/neon.env (V2_DATABASE_URL, V2_R2_PREFIX). Surya's weights: /var/tmp/e19309/cache/datalab
# (downloaded on first use, ~1-2 GB; never the NFS home).
QUEUES=${1:-"ocr-SINHALA ocr-TAMIL"}
T=/var/tmp/e19309
P=$T/sllaw_venv/bin/python
export $(cat $T/neon.env) MODEL_CACHE_DIR=$T/cache/datalab HF_HOME=$T/hf TORCH_HOME=$T/cache/torch
mkdir -p "$MODEL_CACHE_DIR" ~/sllaw/logs
cd ~/sllaw
while true; do
  for q in $QUEUES; do
    n=$($P -m etl.v2.run status 2>/dev/null | awk -v q="$q" '$1 == q && $2 == "todo" {print $3}')
    if [ "${n:-0}" -gt 0 ]; then
      G=$(nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits | sort -t, -k2 -nr | head -1 | cut -d, -f1)
      echo "$(date '+%F %T') $q: $n waiting, worker on card $G" >> ~/sllaw/logs/ocr_host.log
      CUDA_VISIBLE_DEVICES=$G $P -u -m etl.v2.run work "$q" --n 1 >> ~/sllaw/logs/ocr_host_$q.log 2>&1
    fi
  done
  sleep 300
done
