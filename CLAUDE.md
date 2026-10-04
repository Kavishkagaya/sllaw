# sllaw — Sri Lanka Law Document Processing

## What this project is

A corpus of Sri Lankan law: Constitution, Acts, consolidated statutes and regulations first, then judgments. The pipeline fetches every source file once into R2, extracts it once (docling for text-layer PDFs, Chandra for scans), and keeps the raw output unchanged. All structuring (sections, schedules, knowledge graph) runs afterwards from that raw output.

## Layout

```
CLAUDE.md          this guide
requirements.txt   pinned Python deps
.env.example       DATABASE_URL (Neon) + R2_* (Cloudflare)
docs/
  SOURCES.md       scope, every source site, coverage, blockers, open datasets, prior art
  PIPELINE.md      decisions (extract once, router, engines), validation rules, measurements
  LAYOUT.md        how Act PDFs are laid out (columns, marginal notes, page types)
etl/               the pipeline: one file per step
  fetch.py         step 1: list sources → PDFs into R2 → rows in Neon
  extract.py       step 2: router → docling (text layer) / Chandra (scans) → raw JSON into R2
  migrate.py       applies etl/migrations/*.sql in order
  migrations/
  spiders/acts.py  documents.gov.lk listing (Next.js Server Action)
viewer/            Next.js app for browsing documents from Neon
legacy/            archive of the previous pipelines; read-only, not imported
```

Next step, a new file in `etl/` when built: per-engine adapters that turn docling and Chandra raw output into one common block shape.

## Setup (ada or local)

```bash
git clone https://github.com/Kavishkagaya/sllaw.git && cd sllaw
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                     # fill DATABASE_URL and R2_*
.venv/bin/python3 etl/migrate.py         # apply pending migrations (--status to list)
.venv/bin/python3 -m etl.fetch acts --limit 20   # pilot: 20 files into R2
.venv/bin/python3 -m etl.fetch acts              # everything; re-run to resume or retry

# step 2 needs Chandra's vLLM server for scanned pages. `chandra_vllm --gpu l40s` (48 GB, closest
# to ada's RTX 6000 Ada) runs it through `sudo docker`; without docker, run the same flags via
# `vllm serve datalab-to/chandra-ocr-2 --served-model-name chandra …` (see chandra/scripts/vllm.py).
.venv/bin/python3 -m etl.extract --no-chandra --limit 20   # docling-only files, no server needed
.venv/bin/python3 -m etl.extract --limit 50                # pilot, with the server on :8000
```

Fetching and extraction run on **ada**, never locally: no source files on this machine. Use the `/ada-ssh` skill.

- ada: 3× NVIDIA RTX 6000 Ada (49 GB each), **shared with other users**: check `nvidia-smi` and pick the idle card. Project dir `~/sllaw/` with `.venv`. There is no conda env and no sudo. Chandra server: `etl/chandra_server.sh` (GPU/MEM/PORT env vars), port 8011.

## Sources, scope and decisions

Read [`docs/SOURCES.md`](docs/SOURCES.md) before probing any website or re-checking coverage, and [`docs/PIPELINE.md`](docs/PIPELINE.md) before changing how extraction works. If the answer is there, use it and don't test again.

## Documenting findings and decisions

Investigations are expensive, so never run the same one twice. Whenever a session finds out or decides something that isn't obvious from the code, write it down in the same session:

- **Findings about sources** (an endpoint, record counts, a year range, a file format, a login wall, Cloudflare, a dead site) go in `docs/SOURCES.md`, in the row or table for that source.
- **Scope decisions** (what we collect, which text is authoritative) go in the Scope or Authority section of `docs/SOURCES.md`, along with the reason.
- **Pipeline decisions and measurements** (engines, routing, storage, validation results) go in `docs/PIPELINE.md`.
- **PDF layout facts** go in `docs/LAYOUT.md`.
- **Fixes for known issues** go in "Known issues" below.

Rules:
- Date every finding (`Surveyed YYYY-MM-DD`) and give numbers, not adjectives ("301 PDFs in 2024", not "many").
- If a site has changed, update the existing row rather than adding a contradicting one, and note the date.
- Record dead ends and blockers too ("403", "subscription only", "do not bypass"). They're what stops the next person searching again.
- Record what was *not* checked, so a gap doesn't read as "no data".

## Database

Neon Postgres. `documents` is the only table: one row per source file (listing record verbatim in `meta`, `sha256`, `r2_key`). Schema: `etl/migrations/001_documents.sql`.

```bash
.venv/bin/python3 etl/migrate.py           # apply pending
.venv/bin/python3 etl/migrate.py --status  # show applied / pending
```

## Viewer (`viewer/`)

```bash
cd viewer && npm install && npm run dev    # http://localhost:3000
```

Needs `DATABASE_URL` in `viewer/.env.local`. It currently reads the legacy `chunks` rows.

## Known issues

- **docling `max_num_pages` marks PDF invalid**: use `page_range=(1, N)` instead of `max_num_pages=N`.
- **docling default backend (docling_parse) once failed on gazette PDFs** (older docling). With 2.104 it works on Acts and keeps word cells and fonts, which pypdfium doesn't. `etl/extract.py` uses it and falls back to pypdfium per file.
- **transformers 5.x breaks surya**: `SuryaDecoderConfig` is missing `pad_token_id`. Downgrade to 4.57.6 and add `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()` in `surya/common/surya/decoder/config.py`.
- **Surya on CPU gives 1 box/page**: always run it on ada.
