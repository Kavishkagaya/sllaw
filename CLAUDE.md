# sllaw — Sri Lanka Law Document Processing

## What this project is

ETL pipeline for Sri Lankan government legal documents (acts, consolidated statutes). Scrapes, downloads, extracts structured components (parts, sections, marginal notes), and stores in Neon PostgreSQL.

## Stack

- **docling 2.93.0** — PDF parsing and layout detection (runs on CPU, fast)
- **surya-ocr 0.17.1** — vision-based layout detection (needs GPU for quality results)
- **pypdfium2 4.30.0** — PDF rendering to images (pinned by surya-ocr)
- **transformers 4.57.6** — pinned down from 5.x due to surya-ocr compatibility
- **Python 3.13** in `.venv/`

## Remote GPU

Work that needs Surya or long-running spiders runs on **ada** — use the `/ada-ssh` skill.

- 3× NVIDIA RTX 6000 Ada Generation (49 GB each)
- Conda env: `~/miniconda3/envs/sllaw` (surya, docling, torch+CUDA all installed)
- Project dir on ada: `~/sllaw/`
- Work dir (layout experiments): `~/sllaw_layout/`

## ETL pipelines

See [`etl/CLAUDE.md`](etl/CLAUDE.md) for the full pipeline architecture, `doc_json` schema, parser internals, and common tasks.

### Acts (`etl/acts/`)

Scrapes `documents.gov.lk/view/act/` for acts from 2006 onwards. Two-stage pipeline:

```bash
.venv/bin/python3 etl/migrate.py
.venv/bin/python3 etl/acts/spider.py                   # stage 1: all years
.venv/bin/python3 etl/acts/spider.py --year 2024
.venv/bin/python3 etl/acts/stage2.py --all             # stage 2: structure extraction
.venv/bin/python3 etl/acts/stage2.py --flagged         # re-parse stopped acts
.venv/bin/python3 etl/acts/spider.py --stats
```

**DB tables:** `acts`  
**Stage 1:** discover → download PDF → docling serialise → delete PDF → `status=docling_done`  
**Stage 2:** `docling_json` → structured `doc_json` → `status=extracted`

### Consolidated Statutes (`etl/consolidated/`)

Scrapes lankalaw.net for consolidated statutes. Two collections:

| Collection | Index URL | Content | Count |
|---|---|---|---|
| `2006` | `lankalaw.net/…/consolidated-statutes-upto-2006/` | HTML only | ~1490 |
| `2024` | `lankalaw.net/…/consolidated-acts-2024/` | HTML + PDF | 85 HTML + 304 PDF |

```bash
.venv/bin/python3 etl/consolidated/spider.py --collection 2006
.venv/bin/python3 etl/consolidated/spider.py --collection 2024 --skip-html-dupes
.venv/bin/python3 etl/consolidated/spider.py --stats
```

**DB tables:** `consolidated_statutes`, `consolidated_parts`, `consolidated_sections`

**HTML pipeline:** fetch HTML → BeautifulSoup → store  
**PDF pipeline:** download → docling (global column-gap detection) → store → delete

Consolidated PDFs use a two-column layout (marginal notes left, body right) with gap centre ≈ 159 pt. A global pass across all pages is done first to find the median gap — individual pages often have stray cells bridging the gap, so per-page detection alone fails on ~70% of pages.

Known limitations:
- Date is always `None` (no "Certified on" line in consolidated PDFs)
- Alphanumeric amendment sections (e.g. `1A.`, `1B.`) are absorbed into the preceding numeric section's body

## Document Viewer (`etl/viewer/`)

Next.js 16 app for browsing extracted documents directly from the Neon DB.

```bash
cd etl/viewer
npm install        # first time
npm run dev        # http://localhost:3000
```

**Pages:**

| Route | Description |
|---|---|
| `/` | Listing — tabbed Acts / Consolidated Statutes, server-side search, paginated 60/page |
| `/act/[id]` | Act detail — split PDF + JSON tree |
| `/statute/[id]` | Consolidated statute detail — split PDF + JSON tree |

**Stack:** Next.js App Router (server components) · Drizzle ORM (`node-postgres`) · Tailwind v4

**PDF viewer:** PDFs are proxied through `/api/pdf?url=<encoded>` to bypass iframe embedding restrictions on `documents.gov.lk`. Consolidated HTML-only statutes show JSON only.

**JSON tree:** Recursive collapsible tree. Nodes with > 15 children or depth ≥ 2 start collapsed, so `sections` (100+ keys) is collapsed by default.

**Data source:** Reads `raw_json` from `acts` / `consolidated_statutes`; falls back to structured parts + sections rows when `raw_json` is null.

Requires `DATABASE_URL` in `etl/viewer/.env.local`.

## Database migrations

```bash
.venv/bin/python3 etl/migrate.py           # apply pending
.venv/bin/python3 etl/migrate.py --status  # show applied / pending
```

Migrations live in `etl/migrations/` and are applied in filename order.

## Scripts

| File | What it does |
|---|---|
| `detect_docling.py` | Docling layout detection on `document.pdf`, first 5 pages → `layout_output_docling/` |
| `detect_consolidated.py` | Layout visualiser for consolidated PDFs — shows cluster boxes and column gap |
| `detect_layout.py` | Surya layout detection (CPU, sparse) → `layout_output/` |
| `detect_surya_gpu.py` | Surya layout detection on ada (GPU) → `layout_output_surya/` |

## Known issues / fixes applied

- **transformers 5.x breaks surya** — `SuryaDecoderConfig` missing `pad_token_id`. Fixed by downgrading to 4.57.6 and patching `.venv/lib/python3.13/site-packages/surya/common/surya/decoder/config.py` to add `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()`.
- **docling `max_num_pages` marks PDF invalid** — use `page_range=(1, N)` instead of `max_num_pages=N`.
- **docling default backend fails on gazette PDFs** — use `backend=PyPdfiumDocumentBackend` explicitly in `PdfFormatOption`.
- **Surya on CPU gives 1 box/page** — always run Surya on ada.
- **Consolidated PDF PART headings** — PDF renderer drops space: `"PARTI"` instead of `"PART I"`. Fixed by regex normalisation in `extract_statute.py`.
- **Consolidated PDF column gap** — per-page gap detection fails on ~70% of pages due to bridging cells. Fixed with a global median gap computed in pass 1 before extraction.

## Test PDF

`document.pdf` — Sri Lanka Agrarian Development Act No. 46 of 2000  
Source: `https://documents.gov.lk/view/act/2000/8/46-2000_E.pdf`  
84 pages, 256 KB, PDF points page size 384×552 pt
