#!/bin/bash
# LightOnOCR-3 on the work host (ampere, 2026-10-20): driver 550 = CUDA 12.4, so ada's CUDA 13 stack (vllm 0.31 from
# PyPI, torch 2.13 cu13) won't run; vLLM 0.31.0's cu129 release wheel + torch 2.13.0+cu129 (CUDA 12 minor-version
# compatibility). Everything in /var/tmp/e19309 (survives reboots).
#   bash ~/sllaw/etl/lighton_setup.sh > ~/sllaw/logs/lighton_setup.log 2>&1      # in tmux; then etl/ocr_ada.sh
set -e
T=/var/tmp/e19309; export UV_CACHE_DIR=$T/pip_cache HF_HOME=$T/hf
[ -x $T/lighton_venv/bin/python ] || $T/bin/uv venv $T/lighton_venv --python /usr/bin/python3.10
$T/bin/uv pip install -p $T/lighton_venv/bin/python --index-strategy unsafe-best-match \
    --extra-index-url https://download.pytorch.org/whl/cu129 \
    "vllm @ https://github.com/vllm-project/vllm/releases/download/v0.31.0/vllm-0.31.0+cu129-cp38-abi3-manylinux_2_28_x86_64.whl" \
    "torch==2.13.0+cu129" ninja boto3 psycopg2-binary python-dotenv pypdfium2 requests
$T/lighton_venv/bin/python -c "import torch, vllm; print('torch', torch.__version__, torch.version.cuda, torch.cuda.is_available(), 'vllm', vllm.__version__)"
$T/lighton_venv/bin/hf download lightonai/LightOnOCR-3-0.8B --local-dir $T/models/LightOnOCR-3-0.8B
du -sh $T/lighton_venv $T/models/LightOnOCR-3-0.8B
echo SETUP_DONE
