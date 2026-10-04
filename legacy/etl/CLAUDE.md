# ETL — Sri Lanka Legal Document Pipeline

## Decision: extract once, keep everything (2026-10-04)

OCR and layout detection are the expensive steps (GPU time), so they run **once per document**. Their output is stored complete and unchanged, and every later step (sections, schedules, graph) runs from that stored output. Updates mean new documents, not re-running old ones.

- **Storage:** Cloudflare R2. Source PDFs go at `source/<sha256>.pdf`; raw extraction goes at `raw/<extractor-version>/<doc-id>.json.gz`. Files are **written once and never overwritten**. Neon keeps one row per document (source URL, listing metadata, sha256, status, R2 keys) and is rebuildable from R2.
- **Raw = the OCR engine's output, verbatim.** Store exactly what the engine returns (its own JSON, HTML or text, with whatever boxes and scores it gives), plus engine name, version and parameters. No cleaning, merging or reformatting by us before storing. All post-processing happens afterwards, as often as we like.
- **Engine: Chandra 2 for every document** (chosen 2026-10-04, pending the pilot below). One model does layout and OCR, outputting blocks with labels and bounding boxes. There is no separate OCR model, and docling adds nothing on top: its OCR slot expects line- or word-level engines, not a page-level VLM. Store Chandra's **raw JSON output** (blocks + bboxes), not just the rendered `.md`/`.html`. The 1995 test in `ocr_results/chandra2/3012/` kept only md/html, so its boxes were lost.
  - Published speed: 1.44 pages/s measured, ~2 claimed, on one H100 with vLLM at 96 concurrent. **ada's RTX 6000 Ada speed is not measured yet.**
  - Languages: Tamil is in their benchmark (82.9%); **Sinhala is not listed, so test it.**
  - Licence: model weights are OpenRAIL-M, free for research, personal use and startups under $2M funding/revenue, and **not for use competing with Datalab's API**. Check before any commercial launch.
  - Pilot gate before the full run: measure pages/s on ada's 3 GPUs, Sinhala and Tamil quality on scans and FM-font PDFs, and confirm the raw JSON includes the boxes.
- **Router (per document, then per page):** if the text layer has ≥ ~200 characters/page, use **docling**; if ~0, use **Chandra**. Pages with no text inside a text-layer PDF go to Chandra. Sinhala FM-font PDFs go to docling (FM → Unicode conversion happens later, during post-processing).
- **The two raw shapes differ by design:** docling uses PDF points with origin bottom-left, gives cells plus regions, and plain text. Chandra uses image pixels with origin top-left (e.g. `[0,0,1588,2245]`), gives blocks only, and HTML text. Step 2 is **one adapter per engine** into a single common block shape; everything downstream reads only that shape.
- Parsing (sections, schedules, labels) is a separate, cheap, repeatable step and never edits the raw files.

**Step 1 is built:** `etl/fetch.py` (+ `migrations/002_fetch.sql`). It upserts one row per (act, language) file with the listing record verbatim in `meta.listing`, then archives each file to R2 `source/<sha256>.pdf`. Its queue is `r2_key IS NULL`, so it doesn't touch `status`. The 1,268 existing rows match the spider's URLs exactly (checked 2026-10-04), so discovery merges into them rather than duplicating.

## Pipeline overview

Two independent pipelines share the same migration system and Neon PostgreSQL database.

**Where every source lives, its coverage and its blockers: [`SOURCES.md`](SOURCES.md).** Read it before probing a site.

```
etl/
  acts/           Acts pipeline (documents.gov.lk)
  consolidated/   Consolidated statutes pipeline (lankalaw.net)
  migrations/     SQL migrations applied in filename order
  migrate.py      Migration runner
```

Run migrations before anything else:
```bash
.venv/bin/python3 etl/migrate.py           # apply pending
.venv/bin/python3 etl/migrate.py --status
```

---

## Acts pipeline (`etl/acts/`)

### Status flow

```
discovered → downloaded → docling_done → extracted
                                       → stopped    (no docling_json — needs stage1 re-run)
                                       → failed     (parse exception)
```

### Stage 1 — spider + docling (`spider.py`, `stage1.py`)

Downloads PDFs from `documents.gov.lk`, runs docling layout detection, stores serialised cluster data as `docling_json` (plain JSON, no PDF dependency). PDF is deleted after.

```bash
.venv/bin/python3 etl/acts/spider.py                # all years
.venv/bin/python3 etl/acts/spider.py --year 2024
.venv/bin/python3 etl/acts/spider.py --stats
```

### Stage 2 — structure extraction (`stage2.py`, `extract_act.py`)

Pure JSON pass — reads `docling_json`, writes `doc_json`. No PDF or network needed. Safe to re-run any time.

```bash
.venv/bin/python3 etl/acts/stage2.py --all           # status=docling_done
.venv/bin/python3 etl/acts/stage2.py --flagged       # status=stopped or flagged (re-parse after fix)
.venv/bin/python3 etl/acts/stage2.py --act-id 109
```

To reprocess already-extracted acts after a parser change:
```python
# ad-hoc — no CLI flag for this
cur.execute("SELECT id, act_number, docling_json FROM acts WHERE status='extracted' AND docling_json IS NOT NULL")
```

---

## `doc_json` structure

Every act's `doc_json` field follows this schema:

```json
{
  "title_page": {
    "parliament": "PARLIAMENT OF THE DEMOCRATIC SOCIALIST REPUBLIC...",
    "title":      "COMPANIES ACT",
    "number":     7,
    "year":       2007,
    "certified":  "20th March, 2007",
    "lines":      ["...all lines on cover page..."]
  },
  "title":       "COMPANIES ACT",
  "number":      7,
  "year":        2007,
  "certified":   "20th March, 2007",
  "total_pages": 488,

  "parts": [
    {
      "number": "I",
      "title":  "INCORPORATION OF COMPANIES AND RELATED MATTERS",
      "type":   "chapter",          // only present when act uses CHAPTER as top-level
      "sections": [2, 3, 4, ...],   // flat list of ALL section numbers in this part

      // present when PART contains named CHAPTER sub-groups (e.g. Inland Revenue Act)
      "chapters": [
        {
          "number": "II",
          "title":  "INCOME TAX",
          "sections": [3, 4, 5, ...],
          "subdivisions": [
            {
              "number": "I",
              "title":  "Division I: Taxable Income",
              "sections": [3]
            }
          ]
        }
      ],

      // present when PART (or CHAPTER) contains centered/named sub-groups
      "subdivisions": [
        {
          "title":    "ESSENTIAL CHARACTERISTICS OF COMPANIES",
          "sections": [2, 3]
        }
      ]
    }
  ],

  "sections": {
    "3": {
      "number":      3,
      "short_title": "Different types of companies.",   // from marginal note
      "part":        "I",
      "body": [
        {"type": "subsection", "number": "1", "text": "...", "items": [
          {"label": "(a)", "text": "...", "sub_items": []}
        ]},
        {"type": "list_item",  "label": "(a)", "text": "...", "sub_items": []},
        {"type": "proviso",    "text": "Provided that..."},
        {"type": "text",       "text": "plain continuation text"}
      ]
    },
    "XXIII/1": { ... }   // collision key: same section number appears in two parts
  },

  "schedules": [
    {"name": "FIRST SCHEDULE [Section 14]", "content": ["line 1", "line 2", ...]}
  ],

  "rest": [
    {"reason": "unknown_structural:ARTICLE 5...", "content": ["line 1", ...]}
  ],

  "flags": [
    "rest:unknown_structural:ARTICLE 5...",
    "section_collision:s1_parts_I,II",
    "section_regression:72_to_1"
  ]
}
```

### Hierarchy model

Sri Lankan acts use varying structural depths:

| Depth | Element | Detection |
|---|---|---|
| 1 | `PART I` / `CHAPTER I` (standalone) | `RE_PART` / `RE_CHAPTER` → top-level entry in `parts[]` |
| 2 | `CHAPTER II` inside a PART | `RE_CHAPTER` when `current_part` already set → `parts[].chapters[]` |
| 2 | Centered ALL-CAPS heading | `_is_subdivision_heading()` → `parts[].subdivisions[]` |
| 3 | `Division I: Title` | `RE_DIVISION` → `chapters[].subdivisions[]` or `parts[].subdivisions[]` |

When a section number appears at multiple levels, it is tracked in each:
- `parts[N].sections`
- `parts[N].chapters[M].sections`
- `parts[N].chapters[M].subdivisions[K].sections`

---

## `extract_act.py` — parser internals

### Two-pass architecture

**Pass 1** (`serialize_clusters`) — called once per page during stage 1. Converts docling cluster objects to plain dicts stored in `docling_json.pages[].clusters[]`.

**Pass 2** (`build_document`) — called from stage 2 on stored JSON. No PDF needed.

### Page types

| Type | Condition | Handling |
|---|---|---|
| `sparse` | < 8 cells | skipped |
| `title` | first cluster matches `RE_TITLE_PAGE` | extracted into `doc.title_page`, skipped in body parsing |
| `text` | column gap found | split into body (main) + marginal columns |
| `other` | no column gap, not title | processed as single-column body |

`other` pages before the first structural element on a `text` page are skipped — they are TOC/index pages, not body content (`body_started` guard).

### Column layout

Sri Lankan acts have a two-column layout: marginal notes (short titles) on one side, body text on the other. `find_column_gap_d()` finds the largest gap between text intervals. When a gap is found, `page_elements_d()` assigns cells to body or marginal based on which side of the gap they fall.

Body column position varies by page — some pages have body on the left (cx ≈ 264 pt), others on the right (cx ≈ 331 pt). Both cases are handled correctly.

### Centered heading detection

`_body_center(elems)` computes the body column center from the widest elements on the page (≥ 70% of max width). `_is_subdivision_heading(elem, body_cx, body_max_w)` returns True when:
- element center is within ±20 pt of body center
- element width < 85% of body width
- text is ALL_CAPS

These are thematic sub-headings (e.g. "ESSENTIAL CHARACTERISTICS OF COMPANIES") that group sections within a part, stored in `subdivisions[]`.

### `classify(text)` kinds

| Kind | Pattern | Example |
|---|---|---|
| `section_opener` | `N.` or `NA.` | `47. (1) ...` |
| `part_header` | `PART IV` | creates entry in `parts[]` |
| `chapter_header` | `CHAPTER III` | top-level or sub-chapter within PART |
| `division_header` | `Division I: Title` | subdivision within chapter or part |
| `schedule_header` | `FIRST SCHEDULE`, `TABLE A` | starts schedule collection |
| `subsection` | `(1)` | added to current section body |
| `list_item` | `(a)` | added to last subsection or section body |
| `sub_item` | `(iv)` | added to last list item |
| `proviso` | `Provided` | added to section body |
| `unknown` | `RE_STRUCTURAL_ALARM` match | diverted to `rest` |
| `text` | everything else | added to current section body |

`RE_STRUCTURAL_ALARM` catches written-out `SECTION N` and `ARTICLE N` — patterns that don't fit the standard hierarchy and go to `rest` with a flag.

### `build_structure()` state machine

Key state variables: `current_part`, `current_chapter`, `current_subdivision`, `current_section`, `_awaiting_title_obj`, `body_started`, `in_schedule`.

Section state persists across page-type boundaries — an `other`-type page mid-section continues appending to the same section as the preceding `text` page.

---

## Consolidated statutes pipeline (`etl/consolidated/`)

Two collections scraped from lankalaw.net:

| Collection | Type | Count |
|---|---|---|
| `2006` | HTML only | ~1490 |
| `2024` | HTML + PDF | 85 HTML + 304 PDF |

```bash
.venv/bin/python3 etl/consolidated/spider.py --collection 2006
.venv/bin/python3 etl/consolidated/spider.py --collection 2024 --skip-html-dupes
.venv/bin/python3 etl/consolidated/spider.py --stats
```

Consolidated PDFs use a two-column layout with gap centre ≈ 159 pt. A global median gap is computed in pass 1 because per-page detection fails on ~70% of pages (bridging cells). HTML statutes are parsed with BeautifulSoup.

**DB tables:** `consolidated_statutes`, `consolidated_parts`, `consolidated_sections`

---

## DB status counts (as of 2026-05)

| Status | Count | Meaning |
|---|---|---|
| `extracted` | ~680 | fully parsed, `doc_json` populated |
| `stopped` | ~45 | no `docling_json` — stage 1 re-run needed (PDF re-download) |
| `failed` | ~6 | stage 2 parse exception |

Acts with `flagged=true` have quality issues in `flag_reasons` (section collisions, unknown structural patterns, etc.) — not blocking but worth inspecting.

---

## Common tasks

**Re-parse a single act after fixing the parser:**
```bash
.venv/bin/python3 etl/acts/stage2.py --act-id <id>
```

**Re-parse all stopped acts (have docling_json):**
```bash
.venv/bin/python3 etl/acts/stage2.py --flagged
```

**Check what's in rest for an act:**
```sql
SELECT flag_reasons, jsonb_array_length(doc_json->'rest') FROM acts WHERE id = <id>;
```

**Find acts with a specific structural pattern in rest:**
```sql
SELECT id, act_number FROM acts WHERE flag_reasons && ARRAY['rest:unknown_structural:ARTICLE 5...'];
```

## Document shapes (measured on 16-act corpus, `pipeline/out/`)

`etl/parse/pdf.py` maps every shape to one of five chunk `kind`s. Counts are
chunks produced from 380 extracted sections.

| kind | Marker | Chunks | Note |
|---|---|---|---|
| `section` | `1.` `12A.` | 737 | alphanumeric openers now split, were absorbed |
| `chapter` | `CHAPTER 262` | 81 | was undetected |
| `schedule` | `FIRST SCHEDULE` | 21 | was glued onto the last section |
| `part` | `PART I` | 4 | was undetected |
| `preamble` | long title / enacting formula / `Certified on` | 0 | needs the PDF — `parse()` walks the pages before s.1 |

Sub-structure (`(1)`, `(a)`, `(i)`, provisos, quoted insertions) stays inside a
chunk — no rows. Quoted insertions are tracked by quote depth so the principal
enactment's section numbers never open a chunk.

**Noise stripped** (was inside body text, corrupting embeddings and citations):
running headers 218 → 0, printer trailers 18 → 0. Total 545 lines / 21.8k chars,
−2.58% of corpus.

Header detection is frequency-based (a line recurs ≥3× with digits removed) plus
a citation pattern for short acts whose header repeats only once or twice.

### Verified end-to-end (6 acts, 238 pages, fetched from the live site)

| Metric | Result |
|---|---|
| chunks | 377 |
| preamble recovered | **6/6** — all carry `Certified on` |
| title resolved from running header | 6/6 |
| parts detected | 12 |
| schedules detected | 3 |
| chunks carrying a marginal note | 330/377 (88%) |
| running-header bleed | 136 → **0** |
| printer trailer | 22 → **0** |

### documents.gov.lk moved

The site is now a Next.js app; `documents.gov.lk/view/act/acts_<year>.html` is dead
and the old `etl/acts/spider.py` 404s on every request.

There is **no public REST API**. The listing table is a React Server Component and
its paging runs through a Next.js **Server Action**, so the spider invokes it the
same way the browser does:

```
POST https://documents.gov.lk/web/acts
Next-Action: <id of "TableDataAction">
body: [{"apiEndpoint": "<internal endpoint from the page payload>",
        "page": 1, "limit": 2000, "q": "...", "search": "..."}]
```

The action id and `apiEndpoint` are build-specific — `discover()` scrapes both at
runtime, never hard-code them. The response is an RSC flight stream; the row
starting `{"data":` holds the records and `pagination`.

`http://203.143.21.148:4500/website-data/...` appears in the JS as a fallback and
does answer, but it is a **dead backend** — it returned Postgres
`database system is in recovery` continuously for over 10 minutes while the Server
Action served every request. Do not use it.

Downloads: `https://documents.gov.lk/api/content-file-proxy?file=/<uploadedFile>`
— note the **leading slash**. `/api/file-proxy` serves site images but returns
`specified key does not exist` for `act-content/*`.

### New acts spider — `etl/spiders/acts.py`

Crawl + download only; no parsing, no DB.

```bash
python3 etl/spiders/acts.py --out corpus            # every page
python3 etl/spiders/acts.py --search "inland revenue"
python3 etl/spiders/acts.py --pages 3 --limit 50 --list
```

- **1730 acts, 1980–2026**, verified 1730/1730 unique records crawled.
- Upstream ordering is **not stable across pages** — paging at `limit=100` yielded
  1727 of 1730. `crawl()` dedupes by id and widens the page size to the full total
  in one request, which avoids the problem entirely. `--pages` keeps real paging.
- `--search` paginates normally (verified: "inland revenue" -> 20 over 2 pages).
- Writes `<out>/<act_no>.pdf` + `manifest.jsonl`; re-running resumes.

---

## The chunk pipeline (`etl/parse/`, `etl/qa.py`, `etl/run.py`)

Replaces the docling two-stage act pipeline. Spiders fetch, parsers chunk, QA
gates, `run.py` persists — each stage has exactly one job.

```
                 ┌─ probe: chars/page ─┐
   PDF ──────────┤                     ├─ scanned ──→ ocr_pending  [engine not wired]
                 └─ digital ───────────┘
                        │
   HTML ────────────────┼── parse.pdf / parse.html ──→ chunks
                        │
                     etl.qa                       completeness report
                        │
              ┌─────────┴─────────┐
          ok=true              flags[]
              │                    │
        → chunks table       → status=qa_flagged
```

| File | Job |
|---|---|
| `etl/spiders/acts.py` | crawl + download, nothing else |
| `etl/parse/layout.py` | pypdfium2 column/band reader (was `pipeline/extract_digital.py`) |
| `etl/parse/pdf.py` | PDF → chunks. `build()` is the shared anchoring core |
| `etl/parse/html.py` | lankalaw HTML → chunks, via the same `build()` |
| `etl/qa.py` | completeness gate, source-agnostic |
| `etl/run.py` | probe → parse → qa → persist |

Both parsers emit one shape, so `chunks` has a single writer path:

```python
{"idx", "kind", "anchor", "part", "chapter", "note", "pages", "breadcrumb", "text"}
```

```bash
python3 -m etl.run --manifest corpus/manifest.jsonl            # acts
python3 -m etl.run --html 'downloads/*.html' --source consolidated
python3 -m etl.run --manifest corpus/manifest.jsonl --dry-run  # JSON out, no DB
```

Every module runs its own check: `python3 -m etl.parse.pdf`, `-m etl.parse.html`,
`-m etl.qa`.

### Status flow

```
discovered → chunked → qa_pass    → indexed
                     → qa_flagged → review
           → scanned → ocr_pending
```

### Migrations

`007_documents_chunks.sql` creates `documents` + `chunks`.
`008_drop_legacy.sql` drops `parts`, `sections`, `consolidated_parts`,
`consolidated_sections` — kept separate, and **do not run it** until the viewer
reads chunks and the ~680 acts holding `docling_json` have been re-chunked. The
old `etl/acts/` code is the only way to re-parse those rows.

### OCR scope (measured, all 1730 acts)

| Era | Acts | English PDF |
|---|---|---|
| pre-1990 | 455 | 139 (31%) |
| 1990–99 | 339 | 201 (59%) |
| 2000–05 | 200 | 196 (98%) |
| 2006–15 | 414 | 411 (99%) |
| 2016–26 | 322 | 321 (100%) |

**462 acts have no English PDF at all** — OCR cannot help those. Probing 20 acts:
everything from 2000 on is digital (~1450 chars/page), 1990s samples are scanned
(0 chars/page). So roughly **340 English acts need OCR, 928 are ready now**. The
cliff is 2000, not 2006.

`ocr_results/out/engines_summary.json` already ranks engines: rapidocr 33.6s,
easyocr 98.9s, surya 750.5s for comparable output. Surya costs 22x for 22% more
characters. The hard part is not recognition — `parse.pdf` binds marginal notes by
y-position from pypdfium2, so an OCR path needs an adapter presenting the same
(x, y, text) geometry before `build()` can consume it.

---

## Validation rules: what holds and what doesn't (tested 2026-10-04)

Several "self-checks" were proposed as a way to verify extraction without reading documents. They were tested against the 890 parsed Acts in the DB (`documents` with status `qa_pass`/`qa_flagged`, 27,953 chunks). **Do not re-propose a rule marked wrong without new evidence.**

| Rule | Verdict | Evidence |
|---|---|---|
| "Sections run 1..N; a missing number means a missing section" | **Wrong as a check** | 118/890 Acts (13%) have gaps, equally in amending (12%) and principal (14%) Acts. Of 238 missing numbers, 75 appear as openers inside **quoted substituted text** (17/2026 s.3 and s.27 after "the following section is substituted therefor") or **numbered schedule lists** (34/2022 Seventh Schedule item 1; 19/2022 list of Ordinances, items 28 and 29). The other 163 aren't in any chunk; whether lost or never present can't be told without the PDF. Quoted numbers can also *fill* a real gap and hide a loss. The rule only works once quotes and schedules are fenced off, which is the extraction problem itself |
| "Every section has a marginal note" | **True but useless as a correctness check** | 96% of sections that open with their own number have a note (604/15,778 don't). But presence ≠ correct: 388/23,215 notes are letter-salad from overlapping glyphs (12/2005 s.3: "Magistrate's Ch g Court … ihdi j … i11 d g"), and notes bleed into the body text (12/2026 s.6 "Fund of the Authority") |
| "Longer Acts open with an Arrangement of Sections" | **Unverified** | 0/890 Acts have one in their chunks, but the parser deliberately skips the pages before the body (TOC/index guard), so the DB can't show it. Needs a check against the PDFs on ada |
| "The three language versions have the same sections" | **Unverified, and unusable now** | Most Acts from 1980–98 have only one language. Sinhala is scans or legacy FM font, so it can't be parsed to compare |
| "~390 Acts have a lankalaw consolidation to compare against" | **Wrong** | The 2024 collection (85 HTML + 304 PDF) is *consolidated statutes*: the principal enactment with later amendments merged in, many of them pre-2006 Ordinances. It differs from the as-enacted Act by design whenever the Act was amended |
| "Acts since ~2000 share one template" | **Partly wrong** | Page size changed from 384×552 to A4 between 2003 and 2010 (FINDINGS.md). Appropriation Acts are financial tables, not text Acts |

**`qa_pass` does not mean correct.** The gate tolerates `max(3, 10%)` numbering gaps, so Acts with known losses pass: 12/2026 (6+ missing sections, including 165, 221 and 226) and 17/2025 (sections 1–3 missing) are both `qa_pass`.

**Open problem:** no automatic check proves an Act was extracted correctly. Every rule above either depends on the extraction it is meant to verify (quotes and schedules) or measures presence, not correctness. Until there is one, correctness needs a hand-checked sample: real Acts compared section by section against the PDF.

### Element census (2026-10-04)

Share of the 890 parsed Acts whose chunk text contains each element. These are **lower bounds**: text the parser dropped can't be counted, and the patterns are rough.

| Element | Acts | Element | Acts |
|---|---|---|---|
| Definitions (`"x" means`) | 51% | CHAPTER heading | 2.6% |
| Proviso (`Provided that`) | 33% | FORM heading | 1.0% |
| Quoted insertion or substitution | 29% | Illustrations | 0.6% |
| PART heading | 16.5% | Article numbering | 0.6% |
| SCHEDULE heading | 14% | Explanation | 0.4% |
| Savings / transitional | 13.5% | TABLE, Division, Sub-Part | ≤0.1% each |

No APPENDIX or ANNEX headings were found in the parsed Acts. The variety is real but long-tailed: a handful of element types cover nearly everything, and the rest are rare.
