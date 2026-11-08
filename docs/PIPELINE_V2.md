# Pipeline v2 (plan, 2026-11-07)

A clean restart of the ETL, agreed with the user on 2026-11-07. Each point is **Decided** (with date) or **Open**.
The current pipeline (PIPELINE.md) keeps running until a stage here replaces its part; stages move one at a time.

## Why

Found 2026-11-07 by reading the current code:
- **Two engines on the same pages:** docling's layout pass runs on scans that LightOn then reads; on 2026-10-10
  LightOn read every page of 2,514 PDFs, born-digital ones too, which docling had already read.
- **Chunk ids change on every build:** `etl.docs build` deletes and reinserts each document, so embed re-upserted
  105,815 Zilliz rows to change 8,298 (2026-10-20); citations cannot keep a chunk id.
- **No incremental build:** `etl.docs build` rebuilds all 7,336 documents; its workers deadlocked (2026-10-29).
- **Each law structured twice:** `etl.structure` runs the old section assembler (twice per LightOn file) only for
  key, title and dates, then `etl.docs` reads and parses the same raw again; `etl.graph build` makes change edges
  nothing reads (only its same_as pairs are used).
- **Spiders depend on each other:** `discover_lankalaw` and `discover_parliament` skip what other sources hold.

## Shape

```
 per source, per type                    per document, corpus-wide where noted
 ────────────────────────────────────     ──────────────────────────────────────────────────────────
 1 listing ─► 2 fetch ─► 3 extract ─►    4 structure ─► 5 chunk ─► 6 links ─► 7 publish ─► 8 embed
 (spiders)    (rank,      (one engine      (blocks ->     (tree ->    (refs,     (app's Neon) (Zilliz,
              language,    per page;        tree.json      chunks:     same_as)                changed
              overrides)   blocks)          in R2)         text in R2)                         text only)

 state: one Neon database (small rows)        bytes: R2 (files, raw, text, listings, manifests)
 workers: any host, claim items from Neon     human fixes: etl/overrides.json in git
```

## State and workers

- **Decided 2026-11-07: the ETL's state is a new Neon database, shared by every worker.** No local Postgres, no
  backup/restore. Possible because text leaves the database: every byte is in R2; Neon holds small rows
  (listings, inventory, work items, fingerprints, chunk metadata without text, links).
- **Decided 2026-11-07: workers claim items from Neon** (`FOR UPDATE SKIP LOCKED` + a lease that expires): any host
  can start a worker, no two take the same item, a crashed worker's lease runs out and another takes the item.
  R2 outputs are content-addressed, so even a double write is identical.
- **Decided 2026-11-07: every stage is resumable by itself:** an item is skipped when its output exists for the same
  fingerprint (input hash + code version).
- **Decided 2026-11-07: R2 alone can rebuild stages 1-2** (listing snapshots + manifests + `etl/overrides.json`), so
  losing Neon loses no data.
- Open: Neon's free limits (5 GB/month egress, compute hours): heavy joins stay inside Neon, text is read from R2,
  workers back off instead of polling.
- Open: corpus-wide steps (link resolution, same_as) run one at a time through a lease row (Postgres advisory locks
  do not hold through Neon's pooler).
- Open: which Neon project; leaning to a separate ETL database in the app's project, publish a copy between the two
  so the app never sees a half-built state.
- Open: the orchestrator. The user proposed Airflow (2026-11-07); Dagster (assets with code versions) and Prefect
  (hosted scheduler, workers only on our hosts) were raised as lighter fits for hosts with no always-on machine.

## Stage 1: listing (spiders)

- **Decided 2026-11-07: spiders are free of source dependencies.** Every spider lists everything it sees; none
  filters on what another source holds. Choosing a file per document happens in stage 2.
- **Decided 2026-11-07: a spider is (source × listing) and types each row;** the listing for a type is the union of
  every spider's rows of that type. One listing can hold two types (parliament.lk's Acts table has Acts and the
  1972-78 "(L)" Laws).
- **Decided 2026-11-07: types are what the document is in law, never where it came from; more types are better
  than fewer.** Language, source and format are row attributes.

  | Type | Key | Spiders now |
  |---|---|---|
  | `constitution` | `constitution` | parliament.lk |
  | `constitution_consolidation` | `constitution:N` | parliament.lk |
  | `constitution_amendment` | `amendment:N` | documents.gov.lk, parliament.lk |
  | `act` | `act:N/YYYY` | documents.gov.lk, parliament.lk, lankalaw, CommonLII |
  | `law` (National State Assembly, 1972-78) | `law:N/YYYY` | parliament.lk, lankalaw, CommonLII |
  | `ordinance` | `ordinance:N/YYYY` | none yet |
  | `revised_1956` | `cap1956:N` | lankalaw |
  | `revised_1980` | `cap:N` | lankalaw |
  | `gazette` | `gazette:NNNN/NN` | documents.gov.lk |
  | `supreme_court_judgment` | open | supremecourt.lk (Cloudflare, blocked) |
  | `court_of_appeal_judgment` | open | courtofappeal.lk |
  | reserved: `revised_1938` (`chapter1938:N`, 59 cited), `bill`, `sc_bill_determination`, `provincial_statute` | | none |

- **Decided 2026-11-07: every language is listed** (Sinhala and Tamil too), so coverage per document is known
  without fetching: held in English, held only in another language, or missing (known only from citations).
- **Decided 2026-11-07: a row** = one file of one document from one source: type, `listed_key` (what the listing
  claims; the text may disagree, stage 4 checks it against the text), title, date + precision, language, source, source_url,
  format, the listing record verbatim, first_seen, last_seen. Upsert on (source, source_url); a rerun only moves
  last_seen; rows are never deleted (gone from the site = an old last_seen).
- **Decided 2026-11-07: a crawl over many pages keeps its place,** so a crashed spider continues (CommonLII through
  archive.org took ~70 s an Act).
- **Decided 2026-11-07: each spider run also writes its rows to R2,** `listings/<source>/<spider>/<date>.jsonl.gz`
  (one PUT a run, a few MB gzipped at most).

## Stage 2: fetch

- **Decided 2026-11-07: one file per document, chosen by rank, language and human fixes.** The rank per type
  (1 = preferred; a failed download, 404 or dead host, falls to the next):

  | Type | Rank |
  |---|---|
  | `act` | documents.gov.lk → parliament.lk → lankalaw → CommonLII |
  | `law` | parliament.lk → lankalaw → CommonLII |
  | `constitution_amendment` | documents.gov.lk → parliament.lk |
  | `revised_1980` | lankalaw → CommonLII |
  | `revised_1956`, `constitution`, `constitution_consolidation`, `gazette` | one source each |

- **Decided 2026-11-07: language fallback.** English from any source first, then Sinhala, then Tamil: English from
  lankalaw beats Sinhala from documents.gov.lk. This reverses, for documents without English, "Tamil out of scope"
  (2026-10-06) and "Sinhala files not kept" (2026-10-10) in SOURCES.md.
- **Decided 2026-11-07: human fixes, three kinds, in git** (`etl/overrides.json`, loaded into Neon each run; an
  admin page may write the same file later). Each has what, reason, who, when:
  - `pin`: this document uses this listing (act:28/1969 → lankalaw's HTML; the top-ranked file is another law).
  - `reject`: never use this listing (parliament.lk 5684.pdf is Fugitive Persons 29/1969).
  - `rekey`: this listing is that document (parliament.lk 6284.pdf is act:42/2022, listed as 42/2023).
  Replaces `meta.wrong_file`, `etl.docs keys --fix` and hand-restored `acts` rows.
- **Decided 2026-11-07: files stay at `source/<sha256>.<ext>`;** byte-identical files from two sources are stored
  once (553 parliament.lk PDFs are lankalaw's).
- **Decided 2026-11-07: a manifest beside each file,** `source/<sha256>.json`: facts about the file and where it came
  from, nothing derived. Rewritten only when another listing turns out to be the same bytes.

  ```json
  {"sha256": "d2a1c728…", "bytes": 412883, "ext": "pdf", "content_type": "application/pdf",
   "first_fetched": "2026-10-10T04:12:00Z",
   "listings": [{"source": "parliament", "source_url": "https://www.parliament.lk/…/906.pdf",
                 "fetched_from": "https://www.parliament.lk/…/906.pdf", "fetched_at": "2026-10-10T04:12:00Z",
                 "type": "act", "listed_key": "act:5/2012", "language": "ENGLISH"}]}
  ```
  `fetched_from` differs from `source_url` when the Wayback fallback was used.

## Stage 3: extract

- **Decided 2026-11-07 (user): one engine per page, by page kind and language.** Replaces "LightOn on every page"
  (2026-10-10).

  | Page | Engine | Layout | Text |
  |---|---|---|---|
  | born-digital (usable text layer), any language | docling, OCR off | exact word positions (PDF points) and fonts | the text layer, converted to Unicode if in a legacy font |
  | English scan | LightOnOCR-3-0.8B (`grounding`) | blocks with boxes, 0-1000 grid | best measured on our scans |
  | Sinhala scan | docling + Surya | docling regions + Surya line boxes | Surya CER 8.84% (arXiv 2606.29378) |
  | Tamil scan | open | | |

  The router needs only pypdfium (text per page, images, font names): ≥20 text characters and not an OCR layer =
  born-digital; an image and less text, or someone else's OCR layer (`*Minion Pro-21633` fonts) = scan; neither =
  blank. Language per page from the listing, checked on the text.
- **Decided 2026-11-07: legacy-font text layers are converted to Unicode in stage 3,** by font name per word (docling
  keeps them): Sinhala FM fonts (`FMAbhaya` on 9/2023; `YS% ,xld` = ශ්‍රී ලංකා), Tamil Bamini-style (`GPRasanji` on
  9/2023), Unicode fonts (`IskoolaPota` on 12/2026) as they are. A converter is a character table per font family
  plus reordering rules (a vowel sign printed before its consonant, such as කොම්බුව, goes after it in Unicode;
  two-part vowel signs; rakaransaya, yansaya, repaya). The raw output stays as docling gave it; the converted text
  is derived. Open: which years and fonts occur (only 2010, 2023, 2026 sampled, PIPELINE.md); whether to adopt an
  existing open converter or write the table; checked by comparing converted text with OCR of the same pages.
- **Decided 2026-11-07 (user): stage 3's output is blocks, one shape for every engine** (docling text layer,
  LightOn, Surya, HTML rows), so stage 4 never knows which engine read a page. Per page: file, page number,
  width, height, engine; per block: `box` as fractions of the page (one scale for all engines), the engine's own
  `label` if it gives one (`text`, `aside_text`, `header`, `table`, …), `text` (Unicode; a legacy font converted,
  the original glyph text kept in the raw output), `italic`, `bold`, font name, and `rows` for a table. **Facts
  only, no decisions:** stage 3 never says "note" or "section 22"; stage 4 decides what a block is.

  ```json
  {"doc_file": "source/9f2c….pdf", "page": 3, "width": 595, "height": 842, "engine": "lighton-3-0.8b",
   "blocks": [
     {"box": [0.08, 0.06, 0.92, 0.09], "label": "header", "text": "Companies Act, No. 7 of 2007"},
     {"box": [0.12, 0.21, 0.71, 0.34], "label": "text", "text": "22. (1) Every company shall keep a register …"},
     {"box": [0.74, 0.21, 0.92, 0.25], "label": "aside_text", "text": "Register of members.", "italic": true},
     {"box": [0.12, 0.36, 0.71, 0.52], "label": "table", "rows": [["Name", "Address", "Shares"]]}]}
  ```
- Known limits of docling on born-digital pages (LAYOUT.md): its layout model boxes a body line with the note level
  with it and misses 1-2-word notes; notes are placed from word positions, not its boxes, which covers most of it.
- Open: Surya needs transformers 4.57.6 plus a patch (CLAUDE.md, Known issues) and a GPU (1 box a page on CPU); a
  run where Surya fails on some pages must fail the file (docling's `PARTIAL_SUCCESS`, already refused).
- **Sinhala OCR options (surveyed 2026-11-07):**
  - LightOnOCR-3-0.8B: no languages listed on its card (tag English only); writes Telugu-like loops on Sinhala.
  - **Sinhala LightOnOCR-2-1B QLoRA adapter** (huggingface.co/avishadilhara/sinhala-lightonocr-2-1b-Qlora, Apache
    2.0; arXiv 2606.29378, MERCon 2026): trained on `sinhala-ocr-lk-acts-1010`, 1,010 pages of **Sinhala Acts from
    documents.gov.lk** (1981-89, 2000-19; 1990s excluded; no tables, no gazettes). Test set 202 pages: **CER 1.05%,
    WER 5.63%** vs Google Document AI 2.06%, Surya 8.84%, Subasa 9.99%, Tesseract v5 10.69%. Plain page text, no
    boxes. Not chosen (user, 2026-11-07); kept on ampere, `/var/tmp/e19309/models/`: `LightOnOCR-2-1B` (1.9 GB),
    the adapter (158 MB), `LightOnOCR-2-1B-sinhala` (the adapter merged into the base, W + 2·B·A, 364 modules), the
    dataset (832 MB). Not run: the venv with vLLM has no parquet reader.
  - Tamil: no open fine-tune found. Google Document AI best (CER 0.78%, arXiv 2507.18264); Surya the open option.
- **Decided 2026-11-08 (user): LightOn for every language, no Surya.** Surya would not install into `sllaw_venv`:
  `docling-surya` 0.1.0 needs Python >= 3.12 (the venv is 3.10) and `surya-ocr` 0.17.1 (the version the plugin
  needs; 0.22+ has no line OCR) pins `pypdfium2` 4.30 against docling 2.104's 5.14; a second venv was refused.
  The pipeline's `ocr` op serves one model per language (`etl/v2/ocr_models.json`): English LightOnOCR-3-0.8B
  ("grounding", 400 dpi, edge 2048); **Sinhala the merged LightOnOCR-2-1B-sinhala** (image only, edge 1540, as
  trained; CER 1.05% vs Surya 8.84% on the paper's test set); Tamil LightOnOCR-2-1B base. Each is started on the
  freest GPU only when its queue (`ocr-<LANGUAGE>`) has files, and stopped after. Extract now runs docling only and
  leaves every scanned page to that op (`files.ocr_pages`, `files.ocr_lang`). First queue (2026-11-08): English 251
  files / 2,001 pages (mostly 1947-1955 Acts parliament.lk lists and v1 never took), Sinhala 5 / 125, Tamil 2 / 45.

## Stage 4: structure (per document)

- **Decided 2026-11-07 (user): structure is its own step, and its output, the document's tree, is stored**
  (`tree/<doc>.json` in R2, keyed by fingerprint). Chunking (stage 5) reads only the tree, so a change to how
  chunks are cut reruns stage 5 from stored trees without finding the structure again.
- **Decided 2026-11-07 (user): one generic structure finder for every type, with a per-type profile as data**
  (unit word: section, Article, regulation, paragraph; heading words; whether margin notes exist; front matter),
  not a code branch per type. Linking (stage 6) is generic too: regex over chunk text for mentions of any law.
- Input: stage 3's blocks in one shape for every engine (page, box, text, italic/bold, body or margin), so this
  stage never knows which engine read a page. Steps (proposed): drop furniture (running heads, page numbers;
  the profile adds mastheads, cover lines) → margin notes onto the body line level with them → paragraphs
  (a sentence split across blocks joined) → classify each paragraph's candidate kind → build the tree with a
  stack (a numbered line opens a unit or item only if it continues its level's sequence; a heading opens a scope
  and a Schedule restarts numbering; quotes are containers; "(i)" after "(h)" is a letter) → cut out the contents
  page as the expected list → checks.
- Rebuilt only when its fingerprint changes: the hashes of its stage-3 outputs, this stage's code version, its
  profile's version, and any override touching the document.
- **Element census of today's chunks (2026-11-07, ampere, read-only regex over 165k chunk texts; lower bounds:
  text the chunker dropped is not counted).** Share of documents of each kind containing the element:

  | Element | act (2,698) | law (248) | 1980 ch. (516) | 1956 ch. (481) | gazette (3,382) | constitution (6) |
  |---|---|---|---|---|---|---|
  | item `(1)` / `(a)` / `(i)` | 81 / 80 / 47% | 78 / 75 / 44% | 91 / 88 / 49% | 82 / 76 / 38% | 19 / 30 / 17% | all |
  | definition (`" means`) | 42% | 46% | 59% | 57% | 13% | all |
  | proviso (`Provided that`) | 34% | 34% | 48% | 55% | 7% | all |
  | table row (` \| `) | 9% | 0% | 0% | 0% | **42% (20,145 chunks)** | all |
  | PART heading | 14% | 11% | 21% | 18% | 18% | 5 of 6 |
  | CHAPTER heading | 2% | 2% | 91% (each file's title) | 5% | 0% | all |
  | SCHEDULE heading | 14% | 4% | 21% | 1% | 29% | all |
  | FORM / APPENDIX, ANNEX | 2% / 0% | 0% | 5% / 0% | 0% | 0% / 0% | 0 / 5 of 6 |
  | quoted section (`“25A. `) | 3% | 4% | 1% | 0% | 5% | none |
  | Explanation / Illustration | 0% | 0% | 2% / 1% (Penal Code etc., ~190 chunks) | 2% / 1% | 0% | 5 of 6 / 0 |
  | 1980 history tag `[§ 2, 55 of 1961.]` | 0% | 0% | 26% | 1% | 0% | 1 of 6 |
  | footnote marker | 0% | 0% | 0% | 39% | 1% | 2 of 6 |
  | signature, "By Order" | 9% | 8% | 2% | 21% | 65% | 5 of 6 |
  | Sinhala/Tamil script in English text | 0% | 0% | 0% | 0% | 3% | none |
  | TITLE / DIVISION / SUB-PART | 1 doc | 0 | 1 doc | 0 | 0 | 0 |

  Labels and paths now: labelled chunks act 68.9%, law 69.8%, 1980 75.8%, 1956 76.0%, gazette 23.7%,
  constitution 55.2%; "(cont.)" pieces 15-39%; documents with a repeated label: gazette 158, act 14, 1980 3,
  constitution 3, amendment 2.
- Proposed node kinds (from the census, to confirm): front (title, long title, enacting formula; a gazette's
  masthead; a judgment's caption) · heading (Part, Chapter, Schedule, Form, Appendix/Annex) · unit (section,
  Article, regulation, paragraph; with its note) · item (`(1)`, `(a)`, `(i)` levels; proviso, Explanation,
  Illustration as item kinds) · definition · quote (a container: inserted text stays inside the unit quoting it)
  · table · list · annotation (1980 history tags, footnotes) · end (signature, "By Order", date) · furniture
  (dropped).
- Proposed node kinds (from the census, to confirm): front (title, long title, enacting formula; a gazette's
  masthead; a judgment's caption) · heading (Part, Chapter, Schedule, Form, Appendix/Annex) · unit (section,
  Article, regulation, paragraph; with its note) · item (`(1)`, `(a)`, `(i)` levels; proviso, Explanation,
  Illustration as item kinds) · definition · quote (a container: inserted text stays inside the unit quoting it)
  · table · list · annotation (1980 history tags, footnotes) · end (signature, "By Order", date) · furniture
  (dropped).
- Checks, each **flags** the document (none blocks publishing): coverage (every block in exactly one node: no
  text lost), numbering gaps, the contents check below, units without a note where the profile expects notes,
  quotes still open at a unit's end, another script inside an English document (3% of gazettes).
- **Decided 2026-11-07 (user): the printed contents ("Arrangement of Sections") is a check, not thrown away.** Its
  entries (number + note) are compared with the units found in the body; a mismatch (a listed section with no
  unit, or the reverse) **flags** the document for review, it does not block publishing (the contents page can
  have OCR errors itself). Counted per document how many have one: not yet (mostly long Acts; 795 entries in
  the Companies Act 7/2007).
- **Decided 2026-11-07 (user): a "never worse than today" gate before stage 4 replaces the old code.** Per document
  (7,336), today's chunk labels vs the new tree's unit labels: lost = old − new, gained = new − old; one report
  row per document, most lost first. A document with a loss is reviewed: the new code is wrong (fix, rerun) or
  the old label was (cap:73's "s5, s6" were never sections), recorded as an accepted loss. The switch happens
  when no unreviewed loss is left. Read-only, in memory, on today's data on ampere; nothing published.
- Open: the document's key, title and dates come from this same read (no separate `etl.structure` and
  `etl.graph build`), and this is where a `listed_key` the text contradicts is caught.

## Stage 5: chunk (per document)

- **Decided 2026-11-07 (user): chunking is its own step,** reading the stored tree: one unit = one chunk with its
  note; a long unit cut at item boundaries, never mid-sentence (today's limit 1,500 chars); a table whole, or cut
  by rows with its header repeated; front matter, schedules, lists, end matter chunks of their own.
- **Decided 2026-11-07: text leaves the database.** Each document's chunks are JSON in R2, one file per document or
  several parts for a long one (a part ends at a section boundary; 96 of 7,336 laws are over 256 KB, the largest
  1.5 MB, the median 5 KB). The app reads them for the sidebar and the agent's reads; Neon keeps chunk rows (id,
  doc, seq, label, path, part) without text.
- **Decided 2026-11-07 (user): chunk identity.**
  - `address`: the unique key and the breadcrumb in one (user: long is fine): the chunk's full place in the
    structure tree, document key / headings / unit label [#occurrence] / piece: `act:7/2007/Part II/22/2`,
    `act:7/2007/First Schedule/3`, `gazette:2235/22/front/1` (an unlabelled node by its kind). An occurrence number
    when a label repeats (158 gazettes, 14 Acts). Replaces `chunks.path`.
  - `id`: always `uuid5(SLLAW_NAMESPACE, address)` (one fixed project namespace), used for every join, link, Zilliz
    entity, R2 text file and the app. Any worker computes it without a lookup; a full rebuild from R2 gives the
    same ids. **A changed address means the chunk really changed** (a heading found, a section renumbered or cut
    differently), so it is a new id and goes downstream again, cheaply, because downstream keys on `text_hash`:
    embed copies the vector by hash (no model call), links re-resolve in SQL, its R2 part is rewritten, OCR and
    extract never rerun. A saved citation re-finds it by `doc_key` + label + quote, as the app stores them.
  - `text_hash`: sha1 of the text; decides re-embed and republish.
  - Not a text hash as the id (an OCR fix would orphan its links), not a counter (`BIGSERIAL` renumbers every build).
  - Knock-on: Neon `chunks.id`, `links.src_chunk`/`dst_chunk` become `uuid`; the Zilliz primary key VarChar(36); the
    app's chunk ids become strings (the model sees only its short handles, `[[s3]]`).
- Only chunks whose `text_hash` changed go on to stages 6-8.

## Builder v2, first gate run (2026-11-07, ampere, read-only)

`etl/v2/` (blocks.py, tree.py, chunk.py, profiles.py; gate.py runs the gate, show.py prints a document's blocks,
test_v2.py has a parity test against `etl.docs.chunks()`). Stage 3 reuses `etl.structure.blocks()` (the
per-engine readers and the body/margin split); stages 4-5 are new; the unit rules are `etl.docs.chunks()`'s,
unchanged. All 7,336 documents built in memory in 276 s (16 workers), 0 failed, ids unique in every document.

| kind | docs | labels lost / gained | chunks with today's exact text | words recovered |
|---|---|---|---|---|
| act | 2,698 | 0 / 69 | 95.7% | 29,352 in 321 docs |
| law | 248 | 0 / 0 | 99.3% | 103 |
| 1980 edition | 516 | 0 / 0 | 87.0% (wrapped notes joined) | 1,874 in 106 |
| 1956 edition | 481 | 0 / 0 | 99.9% | 20 |
| constitution | 6 | 0 / 5 | 93.0% | 1,399 |
| amendment | 5 | 0 / 0 | 99.7% | 0 |
| gazette | 3,382 | **828 in 114 docs** / 2,904 | 43.4% | **1,018,485 in 1,746** |

- **Found: today's pipeline drops margin blocks it cannot place as notes** (`etl.docs.block_paras`): items, forms,
  schedules, whole sections in Acts ("41. (1) The President shall have the power…", constitution:18), a gazette's
  second column, the continuation lines of a wrapped note (1980 edition). v2 keeps them (blocks.py).
- **Laws pass the gate:** 0 labels lost in 3,954 documents. Changed text: tables over MAX now cut by rows with the
  header repeated (act:15/1979's schedule of offences), recovered text, wrapped notes joined into one note.
- **Gazettes do not pass yet.** Of the 114 documents losing labels, 72 (516 labels) gained a schedule: a recovered
  SCHEDULE heading makes a numbered list schedule items, as it should (gazette:2317/57, monuments 01-11 were read
  as regulations). The other 42 (312 labels) are mostly one by-law series (gazette:2152/34 ... /47, ~9,000 words
  recovered each), where docling cut each line's start into a block of its own ("1.", "(1)", "a."), so recovered
  blocks break the numbering (gazette:2235/54). Fix: rebuild lines from docling's word cells in stage 3. A first
  try that read two-column pages left column then right made single-column pages like these worse: reverted.
- The checks, as flags (existing faults the gate surfaces, not regressions): numbering gaps 655 in 247 Acts;
  contents check on 7 Acts with a printed contents (act:7/2007 sections 245, 306, 521 listed but not found;
  cap:235 34, 37, 41, 42, 60, 62, 116, 163: numbers OCR lost, each merged into the section before); rejected
  openers 4,352 in 808 Acts; units without a note where notes are printed 2,404 in 1,174 Acts; pieces ending
  mid-sentence 2,959 in 441 Acts (cuts at paragraph ends, as today).

- **Decided 2026-11-07 (user): the builder reports its own errors** (`etl/v2/checks.py`, run by `etl.v2.gate`).
  Every issue is located and explained: `{key, check, severity, where, page, evidence, cause}`; severity error
  (a unit label lost against today, a duplicate id), warn (likely ours to fix: a gap whose number a paragraph
  opens with but the rule refused, or that sits inside another paragraph or only in a note; a section the printed
  contents lists and the body lacks; another script), info (a gap whose number is nowhere in the text, refused
  openers, units without a note, pieces ending mid-sentence, margin text kept as body, headings out of sequence).
  Each run writes `issues.jsonl`, `review.md` (documents with errors, then warnings, with evidence) and
  `summary.txt`, which compares with the previous run by issue identity (key, check, where, cause): **fixed and
  new per check**, so a fix shows its effect and a regression shows at once. First run (20261107_160101): 73,203
  issues; errors 828 (all gazette label losses, above); warnings: gaps 2,074 in 539 documents (rejected 1,586,
  inside 307, note only 181), contents missing 336 in 18, other script 19.
- **Decided 2026-11-07 (user): quoted text is content, never a unit.** Text an amending law quotes (a section,
  Part or Schedule it inserts or substitutes) belongs to the amending law's own section that quotes it, however
  much it looks like a section: no label, no place in the numbering, no scope; a long quotation is pieces of that
  section. Today's chunker has no quote tracking: the inserted "12. The members of the Institute shall be paid ..."
  was act:29/1981's own section 12; inserted sections took labels in the amending law (act:1/2018 15A-15H;
  act:31/1995 s10-17, "this Ordinance").
- **How (`etl/v2/tree.py`).** Quoting starts after an amending formula (INTRO with "hereby" / "principal enactment"
  / "have effect as": a principal law's own "in addition to the following:-" is not one, act:7/2007 s119), or, in
  amending laws only, at a paragraph that opens a quote and does not close it. It ends at a paragraph closing the
  quote, or at the law's own next section: the next number (no jump, no letter) that the formula did not name, or
  any number that is itself an amending formula or has an amending note ("General Amendment to the Principal
  Enactment", act:35/1998 s3) not naming that same number ("Replacement of section 29" on the quoted s29 is the
  formula's note, act:3/1994). Formula numbers are read through OCR noise ("Section, 11", law:37/1974). A heading
  inside is quoted only if it opens with a quote mark or the formula named a Schedule / Part; quoted schedules are
  recorded, so their lost labels are explained. Tried and dropped: ending only at an amending formula (whole Acts
  swallowed, 4,677 labels lost); only at the next number (own sections after a short jump lost; real Schedules
  lost); opened-quote quoting in principal laws (real inserted sections lost: act:24/2018 4A, cap:323 5A).
- **Result (run 2026-11-07 ~17:40): law errors 0, `quoted_as_unit` in laws 0** (was 219 once the check was fixed).
  Law labels lost 225, all explained: 195 the old assembler (acts.doc, which tracked quotes) lacks too, 28 quoted
  schedules of amending laws, 6 reviewed and accepted in `etl/overrides.json` (each the replacement or inserted
  text, where the old assembler was wrong). Gaps 2,074 -> 1,861; refused openers 33,139 -> ~31,500.
- **Structure gold set (2026-11-07, `etl/v2/gold_structure.json`).** 50 amending laws sampled at random
  (`python -m etl.v2.golddump --n 50 --seed 7`; the 28 laws the quote rules were tuned on left out), labelled by
  reading their text without v2's output: 435 own sections, 105 quoted numbers (inserted or substituted sections),
  plus notes for quoted text that reuses the law's own numbers (act:16/2026's quoted s21 after own s21;
  law:10/1974's quoted ss15-32 between own s12 and s13) and own sections whose opener the text lacks (act:1/2015
  s4, act:1/2026 s12: not counted). The gate scores v2 and today's build on it every run (own sections found,
  units that are not own sections, quoted text as a unit, laws exactly right); a miss is a `gold_missing` /
  `gold_extra` error. **First score:** v2 432/435 found, 0 extra, 48/50 laws exact; today 427/435, 1 extra,
  46/50. The 3 misses gave two generic fixes: a short jump is accepted for an amending formula without a note
  (act:1/2015 s5 after an opener OCR lost), a stray mark before a number is dropped (". 29. Section 161", act:52/1998).
  **Then: v2 435/435, 0 extra, 50/50.** The set is now tuned on too: a fresh sample (another seed) is the
  honest measure of the next change.
- **One formula parser (2026-11-07).** The tree takes the section numbers an amending formula replaces or inserts
  from `etl/refs.py` (`formula_numbers()` in tree.py), the parser the links use, instead of its own regex, so
  structure and links read a formula alike. refs.py now tolerates OCR noise there ("Section, 11 ... Is hereby.
  repealed", law:37/1974): `test_refs` passes; the 210-link gold set (`etl.docs gold`) is not rerun yet (it needs a
  relink of the work host's database). Full gate after the switch: law errors 0, gold 435/435, against the run
  before: no change but notes (no_note fixed 3 new 4, rejected_opener new 5). A regression found on the way and
  fixed: the amending-formula jump let a quoted "13. ... hereby amended" (act:20/2013) and an out-of-order s5
  (act:58/1981) pass; a jump now also needs that no next opener fills the gap and that the quoted formula did not
  name the number.
- **Decided 2026-11-07: accepting a reviewed issue.** `etl/overrides.json` (JSON: the ETL venv has no YAML parser,
  and no package is installed without asking) holds the human fixes; `accept` entries {key, check, where or "*",
  reason, by, at} turn a matching error or warning into "accepted". A lost label the old assembler also lacks is
  info, not an error (a second opinion agrees), as is a quoted schedule's.

## Stage 6: links

- How it works today (read 2026-11-07, `etl/refs.py`, `etl/docs.py`): per document, `refs.links()` runs regexes over
  each chunk's text in order and resolves the target law at once: a number ("Act, No. 5 of 1990") and a chapter
  ("(Chapter 26)") from the text alone, "the principal enactment" from the document's own "hereinafter referred to
  as", **a name ("the Penal Code") from `NAMES`, an index of every held title.** Then `links()` (SQL, ~14 s, whole
  table): same_as aliases, Part/Chapter repeals expanded into section rows, `dst_chunk` = the first chunk with that
  label in the target or a same_as twin. A link to a law not held keeps `dst_doc` + `dst_label` with `dst_chunk`
  empty and is filled when the law arrives. Because names resolve against what is held at extraction time,
  `relink` re-reads every document (35 min) once all are in or after any `refs.py` change.
- **Decided 2026-11-07 (user): outward once, inward when a target appears.**
  - **Outward** (per document, when its chunks' `text_hash` or the refs code version changes): walk its chunks
    once, in order, and store **mentions**: source chunk, kind (amends, repeals, inserts, cites, …), how the law is
    named (number `act:5/1990`, chapter `26`, or a name "the Medical Ordinance"), label ("22"), context.
  - **"The principal enactment" (and "that enactment") is resolved during the walk** (user): replaced by the
    mention it was defined as ("Inland Revenue Act, No. 4 of 1963" → `act:4/1963`; a definition by name stays a
    name mention). No stored mention says "principal", so nothing later needs the document's context.
  - **Resolve** (SQL inside Neon): mention → target document (a number as is; a name through the title index, the
    newest law passed before the citing one; the year rule: no link to a law passed after the citing one) →
    target chunk by label through same_as aliases; Part/Chapter repeals expanded here.
  - **Inward** (when a document is added, or its title or labels change): re-resolve only the mentions waiting on
    it, by key (numbers, chapters) or by title (names). A new law never makes old documents be read again.
  - Each link has a status: target not held · held, label not found · resolved.
  - A full re-read only when `refs.py` itself changes (CPU only: chunk text from R2, no GPU, no OCR).

## Stages 7-8: publish, embed

- **Decided 2026-11-07 (user): send what changed, delete what disappeared** (follows from stable ids + `text_hash`):

  | | publish (app's Neon) | embed (Zilliz) |
  |---|---|---|
  | same id, same `text_hash` | nothing | nothing |
  | same id, new `text_hash` | update | embed, or copy a vector already stored for that hash |
  | new id | insert | copy by `text_hash`, else embed |
  | id gone | delete | delete |

- **Decided 2026-11-07: publish one document at a time in one transaction** (its docs, chunks and links rows), so
  the app never shows half a document. Its R2 text files are written in stage 5 under content-hash names, so they
  exist before any row naming them is published.
- **Decided 2026-11-07 (user): no new Zilliz collection; v2 writes into the live `chunks`** (same schema, Int64
  id). A v2 chunk's vector id is `vid(uuid)` = 2^50 + the uuid's top 48 bits (`downstream.vid`; also `v2_chunks.vid`
  in the app), so it never meets v1's ids (under 10^8). v1's vectors stay until the app reads v2; then
  `run embed --apply --prune-v1` deletes them. Writing v2 vectors before the app switches would return every hit
  twice in the live app, half of them ids it cannot find, so it waits.
- **Decided 2026-11-08 (user): no app copy of the corpus; the app reads the schema `kb` in the state database**
  (Neon `sllaw-etl`). `publish` replaces the changed documents' rows in `kb.docs`, `kb.chunks` (with `vid`) and
  `kb.links` (mentions + resolved links + part_links) in **one transaction that runs inside Postgres** (INSERT ...
  SELECT; no rows leave the database), so the app sees a whole release or none of it, while the pipeline's own tables
  change during a run. Chunk text stays in R2 (`kb.docs.parts`; the app reads it there, decided again 2026-11-08).
  Scratch test (2026-11-08, `etl_v2` on ampere): 7,359 docs, 187,583 chunks, 102,090 links in 14 s, equal to the
  source tables; a rerun publishes 0; two documents marked changed are replaced alone; `vid` in SQL equals
  `downstream.vid` on 2,000 random chunks. The app's `etl_db` package must move to `kb` (uuid ids, text from R2).
- **Dates (2026-11-08): the v2 build had none; it now stores v1's** (`etl/v2/dates.py`, in `docs.meta`): certified =
  the listing's date (a year-only listing as 1 January), else the printed "[Certified on ...]" / "[ 3 rd September ,
  1985 ]" for a year-only listing in the key's year (read from the build's paragraphs: the chunks leave the cover
  out), a 1980 chapter's printed date under its long title; commenced = v1's "this Act shall come into operation on"
  rule on section 1 or a section noted operation/commencement/retrospective, else certified. **Against v1 on 600
  random laws, rebuilt in memory: every act (409), law (33), amendment and the constitution equal on both dates**;
  chapters where v1 had none now get one (1980: 8, 1956: 55 of the sample); not checked by hand. A link is dated by
  its source law's commencement, as v1 (the app's "as at a date").
- **kb's columns (2026-11-08):** `kb.docs` key, kind, title, year, certified, commenced, commencement, long_title,
  source_url (the chosen listing's URL), parts; `kb.chunks` id = vid (an Int64 under 2^53: a JS number, and the
  Zilliz id), uuid, address, seq, label, kind, path (= crumb), part, text_hash; `kb.links` src/dst chunk as vids,
  status, date, plus v1's `same_as` rows from the `same_as` table. Links whose target law was never identified (2 on
  the scratch run) are left out. The app reads text from R2 with a read-only key for the `sllaw` bucket: its own
  `sllaw-files` key gets 403 there (2026-11-08).
- **Decided 2026-11-08 (user): daily, and each stage runs only when it has something to do.** A stage op plans and
  starts no worker when its queue is empty. `marks.gated` holds the state hash (every document's build fingerprint +
  its links' hash, `downstream.checked`) the quality gate last passed: the gold sets and the gate (24 min) are
  skipped when the state equals it, and `publish --apply` refuses any state the gate has not passed (tested: refused
  ungated, published once marked). `marks.embedded` holds the kb version last embedded: embed skips when kb has not
  changed. Embed reads the R2 parts on 16 threads: the dry run over all chunks went from 24 min to 104 s. Steps with
  nothing queued took 8-14 s each in run `5479086b`; the listings take about 9 min, so an unchanged day is ~10 min.
  Schedule `daily` (02:00 Colombo, publish and embed with apply) skips a day while a run is still going; it is off
  until the app reads `kb` (embed --apply before that puts ids the live app cannot map into its search).
- **Decided 2026-11-07 (user): every chunk is embedded again** (bge-m3, `EMBED_LOCAL=1` on a GPU host), no copy by
  hash. bge-m3 (4.3 GB) and `gpu_venv` are on ampere; ada has neither (2026-11-08).

## Fix loop (2026-11-07, gate runs 19-26), each change kept only when the gate showed no law error
- **Gazettes, text layer (stage 3, `blocks.gazette_lines`):** lines rebuilt from docling's line cells (a line start
  "1." was a block of its own); a gap over 18 pt splits a line unless only a number precedes it (hanging indent,
  gazette:2145/01); a number alone on a line joins the paragraph after it (gazette:2235/54); two-column pages read
  left then right. **Gazette label errors 806 -> 134** (60 gazettes); 338 lost labels explained as schedule items
  (a numbered list inside a SCHEDULE: monuments, exempted goods).
- **Gazette numbering restarts** (profile `restarts`): a "1." reading like a provision starts a new instrument
  (`Instrument 2`) when the next openers do not carry on the current numbers (gazette:1816/43's two by-laws).
- **Numbers in the wrong place (`tree.mend`, all laws):** a section number only in the margin note becomes the
  opener (not "17 of 1950", a history tag; not a number some paragraph opens with); a paragraph that swallowed
  the next section is cut there (not inside a table, not for a number some paragraph opens with: cap:339's "18."
  inside s17). **The 1956 Penal Code (cap1956:19) now has 424 sections, today 8; the 1956 Civil Procedure Code
  787.**
- **A jump in numbering** is accepted when the next two openers are n+1 and n+2 (numbers lost before it), only
  with the paragraph's own note in a law with notes, and not when a later opener (next 15) fills the gap; a
  table's first cell never opens a unit (act:1/2015 "4. Head No. |").
- **A schedule's own list stays in it:** a numbered paragraph continuing the schedule's current list (last item
  + 1) is an item, not the law's next section (act:12/2005: 5 sections, then numbered amendments; act:14/1966's
  by-laws 67-; act:34/1961's rules 12-26: today made them sections of the Act).
- **After run 26:** law errors 0; gold 435/435, 50/50; every lost law label explained (second opinion 195, quoted
  25, schedule item 77, accepted 4). Gap warnings 805 (rejected 361, inside 276, note only 168): mostly numbers
  OCR or the source lost, and the newly found sections expose the gaps between them.

## The pipeline base (built 2026-11-07, `etl/v2/`)

Engine-agnostic: every stage is a pair of functions, `plan` (which items are new or changed, by fingerprint) and
`do` (one item), run through one queue in the state database (`work.py`: claim with `FOR UPDATE SKIP LOCKED` and a
30-minute lease, finish, fail, retried up to 3 times; `singleton()` is a lease row for one-at-a-time steps). Any
scheduler (cron, Airflow, Dagster, Prefect, a shell loop) only calls `plan` and starts `work`ers on any host.

| file | what |
|---|---|
| `schema.sql` | the state: listings, files, listing_files, documents, docs, chunks (no text), mentions, links, part_links, issues, work, same_as, published |
| `all.sh` | the whole chain on one host, no engine: listing, then plan + N workers per stage (fetch, extract, build, links), resolve, link gold set, publish/embed dry runs, gate. Run in tmux; refuses to start without `V2_R2_PREFIX` in the env file |
| `work.py` | the queue (plan, claim, finish, fail, singleton, status) |
| `run.py` | the one CLI: `init`, `seed`, `listing`, `plan`/`work` for fetch, extract, build, links, `resolve`, `choose`, `publish`, `embed`, `status` |
| `stages.py` | stages 1-3: listing (every spider, every language, typed rows, R2 snapshot), fetch (choice by language, rank, overrides; download with the Wayback fallback; manifest), extract (docling on text-layer pages only; LightOn on English scans via `V2_OCR_API`; Sinhala/Tamil scans marked waiting) |
| `blocks.py`, `tree.py`, `chunk.py`, `profiles.py`, `checks.py` | stages 3-5 in memory (blocks, tree, chunks, checks) |
| `build.py` | stages 4-5 as a stage: tree and text parts to R2 under content-hash names, then docs/chunks/issues rows |
| `downstream.py` | stages 7-8: publish (changed documents into the `kb` schema of the same database, one transaction inside Postgres; the app reads only `kb`) and embed (per chunk whose text changed, into the live Zilliz `chunks` under `vid(uuid)`); dry runs unless `--apply` |
| `gate.py`, `diag.py`, `golddump.py`, `gold_structure.json` | the gate, its diagnosis tool, the structure gold set |

Environment: `V2_DATABASE_URL` (the state), `R2_*` (as today), `V2_R2_PREFIX` ("" in production, `v2test/` for a
trial; must be set, never defaulted), `V2_OCR_API` (a LightOn vLLM server), `ZILLIZ_*`.

**Tested 2026-11-07 on a scratch state database (`etl_v2` on ampere's local Postgres, not Neon; R2 under
`v2test/`):** `seed` 8,956 listings, 7,377 files, 7,336 documents; `choose` picks today's file for **7,336 of
7,336** documents (after moving today's 12 `wrong_file` markers and 4 text-decided keys into
`etl/overrides.json` as `reject`/`rekey`, and reading amendment ordinals from listing titles); build, links,
resolve on 6 documents (plan again: 0 to build); publish and embed dry runs.

**Full chain, 2026-11-07 22:44 to 2026-11-08 00:35 (`all.sh 12` on ampere, scratch state DB, R2 `v2test/`):**

| step | result |
|---|---|
| listing (7 spiders, 16 min) | documents.gov.lk Acts 4,014 rows; gazettes 10,000 (of 10,031 held: the site's paging shifts, 4 passes saw 38,591 of 39,323 issues; rows are never deleted, an unseen one keeps its row); parliament.lk Acts 2,617; Constitution 6; lankalaw by year 2,621; LE 1980 516; LE 1956 481 |
| fetch (8 min) | 315 downloads, 0 failed; **23 Acts today's pipeline does not have**, among them act:24/2026 and act:25/2026; 1 by language fallback (act:25/1993, Sinhala only) |
| extract (1.5 min) | 2 files (act:54/2007, act:7/2006: scans, marked waiting, no OCR server running) |
| build (26 min, 12 workers) | 7,359 documents, 0 failed |
| links (12 min) + resolve | 101,291 mentions: resolved 86,553, label not found 11,029, target not held 3,709; 799 section links from 33 repealed Parts/Chapters |
| link gold set | **210/210** (201/210 before `part_links`: v2 had no expansion of a repealed Part/Chapter into its sections) |
| publish / embed (dry) | 7,359 documents to publish; 184,288 chunks to embed |
| gate (7,336 documents, 25 min) | law errors **0**; gold 435/435, 50/50; gazette label errors **124** in 58 (run 26: 134 in 60); gap warnings 774 (805) |

Found and fixed on the way: (1) a trial without `V2_R2_PREFIX` wrote 4,904 objects at the bucket root (`tree/`,
`app/law/`, `listings/`, all new prefixes, nothing overwritten; left for the user to delete): `all.sh` now refuses
to start without it, and the build fingerprint holds the prefix, so a build in the wrong place is redone; (2) a
Ctrl-C in the attached tmux pane stopped every worker: `all.sh` ignores it; (3) the gate compared a full run with
a targeted one as if all documents were in both: it now compares only documents both runs checked (`--summary`
rewrites a run's summary against another); (4) one site down no longer stops the listing.

### Workflow engine and state database (2026-11-08)
- **Decided (user): Dagster.** `etl/v2/pipeline.py` is one job, `sllaw_v2`: one listing op per spider (in
  parallel) -> fetch -> extract -> build -> links -> resolve -> link gold set -> quality gate -> publish -> embed.
  Dagster only orchestrates: each op runs the same `python -m etl.v2.run ...` commands in the ETL's venvs
  (`etl_venv`; extract in `sllaw_venv` for docling), and the queue in the state database stays the truth, so an
  op can be retried and other hosts can add workers mid-run. A stage op fails if any item ended `failed`; the link
  gold op fails below 210/210; the gate op fails on an error in anything but a gazette or a structure gold miss;
  publish and embed write only with `apply: true` in the run config. Weekly schedule (Sunday 02:00 Colombo),
  off until turned on in the UI. `all.sh` stays as the no-engine way to run the same chain.
- Dagster 1.13.29 in `/var/tmp/e19309/dagster_venv` on ampere (its own venv); `bash etl/v2/dagster.sh` starts
  the UI (tmux `dgweb`, 127.0.0.1:3070; from a laptop `ssh -L 3070:localhost:3070 ampere`) and the daemon (tmux
  `dgdaemon`, one run at a time). Run history in `/var/tmp/e19309/dagster_home` (SQLite, local disk; losing it
  loses only history). Rerun the script after a reboot.
- **State database: Neon project `sllaw-etl`** (`dawn-hill-39819424`, aws-ap-southeast-1, the region nearest
  ampere: 99 ms a query; Postgres 17; database and role `etl`; direct, not pooled: `resolve` uses a temp table).
  URL only in `/var/tmp/e19309/neon.env` on ampere (with `V2_R2_PREFIX=`, production). Filled 2026-11-08 from the
  scratch state's inventory tables (listings 20,516, files 7,690, listing_files 7,715, documents 7,359, same_as
  1,333); build outputs were not copied (they named `v2test/` objects): the first Dagster run builds them.

### First production run (2026-11-08, Dagster run `b76a802e`, Neon sllaw-etl)
- listings 2-9 min each; fetch, extract, ocr nothing new (4-10 s); **build 7,715 documents in 33 min, 0 failed**
  (the dates: every fingerprint changed); links 8 s (no chunk text changed, nothing relinked); resolve 1 min; link gold
  210/210; **quality gate passed in 25 min** (state `c1d14c01…` marked); **publish 7,715 documents into kb in 14 s**.
- **Embed:** the op then used Workers AI and stopped on one chunk of 10,622 tokens (bge-m3's limit is 8,192); since
  then the op runs bge-m3 locally (gpu_venv, the freest card, `EMBED_LOCAL=1`). **189,374 chunks on one shared A6000
  (100% used by others) in 3 h 17 min, ~960/min**; the rerun found all **192,065 in the index, 0 to upsert**. The
  first mark failed: Neon had closed the connection left idle for 3 h; the mark now opens a fresh one.
- **The app reads kb** (PR #39, merged 2026-11-08, production deployed): `ETL_DATABASE_URL` = role `app_reader`
  (read-only on schema kb), chunk text from R2 with its own token (`R2_LAW_*`, Cloudflare account token
  "sllaw-app law read (kb text parts)": Workers R2 Storage Bucket Item Read on `sllaw` only; tested 2026-11-08: read
  200, write to `sllaw` 403, `sllaw-files` 403; set in Vercel for all three environments, production redeployed). Checked against kb: act:9/2023 263 chunks, none
  without text; cap:25 s114's 1962 amendment with its date; a whole section joined from its "(cont.)" chunks.
- **Cleanup:** R2 `v2test/` deleted (15,144 objects), the scratch database `etl_v2` dropped (320 MB); every
  `app/law/` and `tree/` object (15,533) is referenced by docs or kb.docs, none missing.
- Schedule `daily` turned on 2026-11-08 19:09. **v1's 163,176 vectors deleted** (2026-11-08, `run embed --apply
  --prune-v1`, user's go-ahead; 0 ids under 2^50 left). Before that, a search's top 5 held 2-3 v1 copies the app
  dropped (not in kb); after: 5 of 5 found in kb on two test queries.

### Deploy checklist (each needs the user's go-ahead: they write to shared systems)
1. ~~Create the state database in Neon~~ done 2026-11-08 (`sllaw-etl`, above).
2. `V2_R2_PREFIX=` (empty, production) in the env file, then `bash etl/v2/all.sh`: trees and text parts land in R2
   `tree/`, `app/law/` (new prefixes, nothing overwritten).
3. The app's `etl_db` on `kb` (chunk ids uuid, `vid` for search hits, text read from R2 parts); then the first
   `publish --apply` into Neon's `kb` (needs a gate pass recorded in `marks`: the next run's gate does it).
4. `run embed --apply` (the Dagster op runs bge-m3 locally: gpu_venv, `EMBED_LOCAL=1`, the freest card with 6 GB; 2026-11-08 the first full embed hit Workers AI's 8,192-token limit on one chunk, and the API path now cuts only the text sent to the model, never the stored text), then the app's
   search reads v2 ids, then `run embed --apply --prune-v1`.
5. Turn on the `daily` schedule in the Dagster UI.
6. An OCR server (`V2_OCR_API`, LightOn on a free GPU) for new English scans.
Not done: legacy-font conversion (act:54/2007, act:7/2006 are Sinhala in a legacy font listed as English; nothing
flags it yet), the workflow engine, gate rows for
documents today's pipeline does not have (the gate compares with today's labels, so the 23 new Acts are built and
checked by the builder's own checks but not by the gate).
