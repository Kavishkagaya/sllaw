#!/bin/bash
# Step 2b on ada: two LightOnOCR-3-0.8B vLLM servers, two etl.ocr workers each (shards 0..3 of 4).
#   CARDS="0 2" bash ~/sllaw/etl/ocr_ada.sh       # in tmux or not; logs: ~/sllaw/logs/ocr_*.log
# Everything lives in /var/tmp/e19309, which survives reboots (/tmp does not; 2026-10-09):
#   lighton_venv (vllm 0.31, torch 2.13), models/LightOnOCR-3-0.8B, cache/ (vllm, torch, flashinfer)
# Re-running is safe: workers skip files whose raw/lighton/<sha256>.json.gz exists.
T=/var/tmp/e19309; R=~/sllaw; S=$(date +%Y%m%d_%H%M)
export PATH=$T/lighton_venv/bin:/usr/local/cuda-13/bin:$PATH HF_HOME=$T/hf XDG_CACHE_HOME=$T/cache VLLM_CACHE_ROOT=$T/cache/vllm
read -ra C <<< "${CARDS:-0 2}"
for s in 0 1; do
    G=${C[$s]}; P=$((8013 + s))
    tmux has-session -t ocr_srv$s 2>/dev/null || tmux new-session -d -s ocr_srv$s \
        "CUDA_VISIBLE_DEVICES=$G vllm serve $T/models/LightOnOCR-3-0.8B --served-model-name lighton --port $P \
         --default-chat-template-kwargs '{\"enable_thinking\": false}' --gpu-memory-utilization ${MEM:-0.3} \
         --max-model-len 16384 --limit-mm-per-prompt '{\"image\": 1}' > $R/logs/ocr_srv${s}_$S.log 2>&1"
    for w in 0 1; do
        i=$((2 * s + w))
        tmux has-session -t ocr$i 2>/dev/null || tmux new-session -d -s ocr$i \
            "until curl -sf localhost:$P/health; do tmux has-session -t ocr_srv$s || exit; sleep 5; done; \
             cd $R && $T/lighton_venv/bin/python -u -m etl.ocr --api http://localhost:$P/v1 --shard $i/4 > logs/ocr_${S}_w$i.log 2>&1"
    done
    echo "server $s on card $G, port $P"
done
