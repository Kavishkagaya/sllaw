#!/bin/bash
# Chandra 2 on vLLM without docker/sudo. Flags follow chandra/scripts/vllm.py; memory and
# batch sizes are cut down because ada's GPUs are shared (~26 GB free of 49 per card).
export HF_HOME=/tmp/e19309/hf CUDA_VISIBLE_DEVICES=${GPU:-0}
exec /tmp/e19309/vllm_venv/bin/vllm serve datalab-to/chandra-ocr-2 \
  --served-model-name chandra --port ${PORT:-8011} --dtype bfloat16 \
  --max-model-len 18000 --max-num-seqs 16 --max-num-batched-tokens 4096 \
  --gpu-memory-utilization ${MEM:-0.45} --enable-prefix-caching \
  --mm-processor-kwargs '{"min_pixels": 3136, "max_pixels": 6291456}'
