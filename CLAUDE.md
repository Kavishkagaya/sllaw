# sllaw — Sri Lanka Law Document Processing

## What this project is

Exploring OCR and layout analysis tooling on Sri Lankan government legal PDFs (acts, gazettes). The goal is to identify and extract structured components from scanned/digital legal documents.

## Stack

- **docling 2.93.0** — document parsing and layout detection (runs on CPU, fast)
- **surya-ocr 0.17.1** — vision-based layout detection (needs GPU for quality results)
- **pypdfium2 4.30.0** — PDF rendering to images (pinned by surya-ocr)
- **transformers 4.57.6** — pinned down from 5.x due to surya-ocr compatibility
- **Python 3.13** in `.venv/`

## Remote GPU

Work that needs Surya runs on **ada** — use the `/ada-ssh` skill.

- 3× NVIDIA RTX 6000 Ada Generation (49 GB each)
- Conda env: `~/miniconda3/envs/sllaw` (surya, docling, torch+CUDA all installed)
- Work dir: `~/sllaw_layout/`
- PDF already uploaded: `~/sllaw_layout/document.pdf`

## Known issues / fixes applied

- **transformers 5.x breaks surya** — `SuryaDecoderConfig` missing `pad_token_id`. Fixed by downgrading to 4.57.6 and patching `.venv/lib/python3.13/site-packages/surya/common/surya/decoder/config.py` to add `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()`.
- **docling `max_num_pages` marks PDF invalid** — if the PDF has more pages than the limit, docling marks it invalid. Use `page_range=(1, N)` instead of `max_num_pages=N`.
- **docling default backend fails on this PDF** — use `backend=PyPdfiumDocumentBackend` explicitly in `PdfFormatOption`.
- **Surya on CPU gives 1 box/page** — the foundation model needs GPU to produce dense layout predictions. Always run Surya on ada.

## Scripts

| File | What it does |
|---|---|
| `detect_docling.py` | Docling layout detection, first 5 pages, outputs to `layout_output_docling/` |
| `detect_layout.py` | Surya layout detection (CPU, sparse), first 2 pages, outputs to `layout_output/` |
| `detect_surya_gpu.py` | Surya layout detection for GPU on ada, first 2 pages, outputs to `layout_output_surya/` |

## Test PDF

`document.pdf` — Sri Lanka Agrarian Development Act No. 46 of 2000  
Source: `https://documents.gov.lk/view/act/2000/8/46-2000_E.pdf`  
84 pages, 256 KB, PDF points page size 384×552 pt
