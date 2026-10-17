# sllaw — Sri Lanka Law Document Processing

## What this project is

A corpus of Sri Lankan law: Constitution, Acts, consolidated statutes and regulations first, then judgments. The pipeline fetches every source file once into R2, extracts it once (docling for text-layer PDFs and HTML, LightOnOCR-3 for scans), and keeps the raw output unchanged. Everything after (documents, chunks, links) is rebuilt from that raw output.

## Layout

```
CLAUDE.md          this guide
requirements.txt   pinned Python deps
.env.example       DATABASE_URL (Neon) + R2_* (Cloudflare)
docs/
  SOURCES.md       scope, every source site, coverage, blockers, open datasets, prior art
  PIPELINE.md      decisions (extract once, router, engines), validation rules, measurements
  LAYOUT.md        how Act PDFs are laid out (columns, marginal notes, page types)
  APP.md           the app: who it is for, case-first product, decisions
app/               the app: Turborepo (pnpm) — apps/web Next.js; packages api → services → ai, db, etl_db; app/CLAUDE.md
etl/               the pipeline, in run order
  fetch.py         1: list sources → files into R2 → `documents` rows; spiders/ = one listing per site
  spiders/acts.py  documents.gov.lk listing (Next.js Server Action)
  spiders/lankalaw.py  lankalaw.net Acts by year 1956– (fills gaps; PDF and HTML)
  spiders/le1980.py    lankalaw.net Legislative Enactments 1980 (pre-1980 chapters; cap:N)
  spiders/le1956.py    lankalaw.net Legislative Enactments 1956 (HTML chapters; cap1956:N)
  spiders/commonlii.py CommonLII numbered Acts via the Wayback Machine (only laws we hold no file for)
  spiders/parliament.py parliament.lk Acts listing: official English PDFs 1956– (preferred over lankalaw)
  (fetch.py constitution) parliament.lk 1978 Constitution + consolidations up to the 17th–21st Amendments
  extract.py       2: docling (text layer, HTML) → raw JSON into R2; --ocr-api sends scans to LightOn in the same pass
  ocr.py           2b: LightOnOCR-3-0.8B on scanned pages → raw/lighton/ in R2 (files extracted without --ocr-api)
  structure.py     3: raw → blocks (`blocks()`, also what docs.py reads) → Act JSON; `build` = the `acts` rows:
                   each law's key, title, dates and chosen file (the list etl.docs builds)
  graph.py         4: `build` = change edges from acts.doc, then `link` = same_as between old laws, chapters and
                   editions (`edges`); docs.py uses only the same_as pairs and the name lookups
  docs.py          5: text (LightOn / HTML / docling) → docs + chunks + links (the current model)
  refs.py          links read from the text alone (no marginal notes); `etl.docs relink` reruns it on stored chunks
  publish.py       6: ada → the app's Neon (sllaw-app): docs, chunks, links replaced in one transaction, push-only
  embed.py         7: chunks → bge-m3 (Workers AI) → Zilliz `chunks` (vector + BM25); only changed text is embedded
  backup.py        tables → gzipped CSV in R2 (backups/), read back and counted
  migrate.py       applies etl/migrations/*.sql in order
  test_structure.py, test_refs.py   assert-based checks: `python -m etl.test_structure`
  *_ada.sh         on ada: ada_setup (venv + extract workers), ocr_ada (vLLM + OCR workers),
                   docs_ada (OCR → docs build → relink), db_ada (the project Postgres)
```

Structuring is code-based and English-only (decision 2026-10-04); Sinhala/Tamil go to an agent with the whole Act when needed. Scanned pages before 2000 are read by LightOnOCR-3-0.8B (`etl/ocr.py`, decision 2026-10-09). Pre-1980 law is in (lankalaw 1956–79 Acts, 1956 and 1980 Revised Editions) and `etl.graph link` ties old laws, chapters and editions together: parliament.lk's official PDFs (1956 on) replace lankalaw's copies (2026-10-10); 99.36% of change edges reach their target (78 left: laws with no file anywhere we can reach); CommonLII is the last resort (32 laws no official source has). Laws are keyed `law:`, Acts `act:`. Current model (2026-10-10): `etl/docs.py`, documents → chunks → links between documents (PIPELINE.md, "Documents, chunks and links"); Neon's transfer quota was hit, so never bulk-read doc or chunk text out of Neon. The Constitution is in (2026-10-11): 1978 text + consolidations, 90% of Article links reach their Article. Next: verify edge precision (judge model + gold set), LightOn on the 119 post-2000 files with scanned pages (1,708 pages), schedules split into items. Search is in (2026-10-17): chunks embedded with bge-m3 into Zilliz (`etl/embed.py`), dense-only by default (recall@5 93% English, 60-73% Sinhala/Tamil; BM25 only on demand), contents pages dropped and a breadcrumb per chunk (`chunks.path`). See PIPELINE.md.

## Setup (ada or local)

```bash
git clone https://github.com/Kavishkagaya/sllaw.git && cd sllaw
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                     # fill DATABASE_URL and R2_*
.venv/bin/python3 etl/migrate.py         # apply pending migrations (--status to list)
.venv/bin/python3 -m etl.fetch acts --limit 20   # pilot: 20 files into R2
.venv/bin/python3 -m etl.fetch acts              # everything; re-run to resume or retry

# step 2 on ada (see below): docling for text layers; scans go to a LightOn vLLM server (etl/ocr_ada.sh)
.venv/bin/python3 -m etl.extract --no-ocr --limit 20                          # text-layer files only
.venv/bin/python3 -m etl.extract --limit 50 --ocr-api http://localhost:8013/v1   # scans too
```

Fetching and extraction run on **ada**, never locally: no source files on this machine. Use the `/ada-ssh` skill.

- ada: 3× NVIDIA RTX 6000 Ada (49 GB each), **shared with other users**: check `nvidia-smi` and pick the idle card. Project dir `~/sllaw/`. There is no conda env and no sudo.
- **`/var/tmp/e19309` survives reboots; `/tmp` does not** (wiped 2026-10-05 and 2026-10-09). Everything lives there: `sllaw_venv` (docling, extract), `lighton_venv` (vllm 0.31, torch, boto3, psycopg2: ocr, graph, fetch), `models/LightOnOCR-3-{0.8B,4B}`, `hf`, `pip_cache`, `cache/`; `~/.cache/{torch,docling,vllm,flashinfer,triton}` link there. `bash ~/sllaw/etl/ada_setup.sh` builds `sllaw_venv` if missing and starts 3 extraction workers.
- **Run Python on ada from `/var/tmp/e19309/{sllaw,lighton}_venv/bin/python`, not `~/sllaw/.venv`.** The home directory is NFS (`/new-home`, 8 KB reads; under 3 MB/s bulk): loading docling/torch from it took over 25 minutes on 2026-10-05, against 27 seconds from local disk. Extraction workers exit when the queue is empty: start them after a fetch, not before.
- Store nothing else on ada: jobs stream R2 → memory → R2/Neon. Logs go to `~/sllaw/logs/`.

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

**Since 2026-10-10 the working database is Postgres on ada** (`etl/db_ada.sh`: Postgres 16 + pgvector from the
pgserver wheel, data in `/var/tmp/e19309/pgdata`, `localhost:5433`, URL `DB_LOCAL_URL` in ada's `~/sllaw/.env`;
from here: `ssh -L 5433:localhost:5433 ada`). Neon's free transfer quota (5 GB egress/month) was hit; Neon keeps
the old copy. **The app reads from a new Neon project (decision 2026-10-15)**, filled push-only from ada by `python -m etl.publish` (`APP_DATABASE_URL` in ada's .env; issue #12);
never bulk-read from it in ETL. Backups: `python -m etl.backup <table>` -> `backups/<table>_<time>.csv.gz` in R2
(`documents`, the one table nothing rebuilds: 6,496 rows on 2026-10-10).

Neon Postgres (until 2026-10-10). Tables: `docs`, `chunks`, `links` (migration 003, the current model); `acts` (the list of laws), `edges` (same_as pairs; 002; `sections` there is no longer written, 2026-10-16); `documents`, the file inventory: one row per source file (listing record verbatim in `meta`, `sha256`, `r2_key`). Schema: `etl/migrations/001_documents.sql`.

```bash
.venv/bin/python3 etl/migrate.py           # apply pending
.venv/bin/python3 etl/migrate.py --status  # show applied / pending
```

## Known issues

- **docling `max_num_pages` marks PDF invalid**: use `page_range=(1, N)` instead of `max_num_pages=N`.
- **docling default backend (docling_parse) once failed on gazette PDFs** (older docling). With 2.104 it works on Acts and keeps word cells and fonts, which pypdfium doesn't. `etl/extract.py` uses it and falls back to pypdfium per file.
- **transformers 5.x breaks surya**: `SuryaDecoderConfig` is missing `pad_token_id`. Downgrade to 4.57.6 and add `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()` in `surya/common/surya/decoder/config.py`.
- **Surya on CPU gives 1 box/page**: always run it on ada.
- **ada's DNS sometimes fails to resolve the database host** for a minute or so (three times on 2026-10-10; once it killed all four OCR workers at start): connect with `etl.fetch.pg_connect()`, which retries for ~5 minutes.
- **docling `PARTIAL_SUCCESS` drops pages** when Surya fails on some of them (15/1991 kept 1 of 7). `etl/extract.py` raises on it so the row stays queued; never store a partial raw.
