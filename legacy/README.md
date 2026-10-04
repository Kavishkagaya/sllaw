# legacy/

Read-only archive of the pre-rebuild pipeline (moved here 2026-10-04). **Nothing new goes here and nothing here is imported by `etl/`.** The full untouched snapshot, including the original paths, is the git branch `backup/etl-2026-10-04`.

| Path | What it was |
|---|---|
| `etl/acts/`, `etl/consolidated/` | First pipeline: docling two-stage (`docling_json` → `doc_json`) for Acts and lankalaw consolidated statutes |
| `etl/parse/`, `etl/qa.py`, `etl/run.py` | Second pipeline: pypdfium2 chunker + QA gate that produced the current `documents`/`chunks` rows (819 `qa_pass`, 71 `qa_flagged`, 378 `ocr_pending`) |
| `etl/CLAUDE.md` | That era's internals doc: `doc_json` schema, parser state machine, chunk pipeline |
| `pipeline/` | Experiments that became `etl/parse/` |
| `scripts/detect_*.py` | Layout visualisers (docling clusters, column gap) |
| `ocr_results/` | OCR engine trials (rapidocr, easyocr, surya, Chandra on Act 1/1995), Aug–Oct 2026 |

Imports still say `etl.parse` etc., so to run any of it, check out the backup branch rather than fixing paths here.

---

## Old project-guide sections (verbatim from CLAUDE.md before the rebuild)

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

## Scripts

| File | What it does |
|---|---|
| `detect_docling.py` | Docling layout detection on `document.pdf`, first 5 pages → `layout_output_docling/` |
| `detect_consolidated.py` | Layout visualiser for consolidated PDFs — shows cluster boxes and column gap |
| `detect_layout.py` | Surya layout detection (CPU, sparse) → `layout_output/` |
| `detect_surya_gpu.py` | Surya layout detection on ada (GPU) → `layout_output_surya/` |

## Test PDF

`document.pdf` — Sri Lanka Agrarian Development Act No. 46 of 2000  
Source: `https://documents.gov.lk/view/act/2000/8/46-2000_E.pdf`  
84 pages, 256 KB, PDF points page size 384×552 pt
