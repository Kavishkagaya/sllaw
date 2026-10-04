# Pipeline

Decisions, measurements and dead ends for the extraction pipeline. Sources and access: [SOURCES.md](SOURCES.md). PDF layout: [LAYOUT.md](LAYOUT.md).

## Decision: extract once, keep everything (2026-10-04)

OCR and layout detection are the expensive steps (GPU time), so they run **once per document**. Their output is stored complete and unchanged, and every later step (sections, schedules, graph) runs from that stored output. Updates mean new documents, not re-running old ones.

- **Storage:** Cloudflare R2. Source PDFs go at `source/<sha256>.pdf`; raw extraction goes at `raw/<extractor-version>/<doc-id>.json.gz`. Files are **written once and never overwritten**. Neon keeps one row per document (source URL, listing metadata, sha256, status, R2 keys) and is rebuildable from R2.
- **Raw = the OCR engine's output, verbatim.** Store exactly what the engine returns (its own JSON, HTML or text, with whatever boxes and scores it gives), plus engine name, version and parameters. No cleaning, merging or reformatting by us before storing. All post-processing happens afterwards, as often as we like.
- **Engine: Chandra 2 for every document** (chosen 2026-10-04, pending the pilot below). One model does layout and OCR, outputting blocks with labels and bounding boxes. There is no separate OCR model, and docling adds nothing on top: its OCR slot expects line- or word-level engines, not a page-level VLM. Store Chandra's **raw JSON output** (blocks + bboxes), not just the rendered `.md`/`.html`. The 1995 test in `legacy/ocr_results/chandra2/3012/` kept only md/html, so its boxes were lost.
  - Published speed: 1.44 pages/s measured, ~2 claimed, on one H100 with vLLM at 96 concurrent. **ada's RTX 6000 Ada speed is not measured yet.**
  - Languages: Tamil is in their benchmark (82.9%); **Sinhala is not listed, so test it.**
  - Licence: model weights are OpenRAIL-M, free for research, personal use and startups under $2M funding/revenue, and **not for use competing with Datalab's API**. Check before any commercial launch.
  - Pilot gate before the full run: measure pages/s on ada's 3 GPUs, Sinhala and Tamil quality on scans and FM-font PDFs, and confirm the raw JSON includes the boxes.
- **Router (per document, then per page):** if the text layer has ≥ ~200 characters/page, use **docling**; if ~0, use **Chandra**. Pages with no text **and an image object** (scans) go to Chandra; pages with neither are blank and skipped. The pilot (2026-10-04) found 1–2 blank versos in nearly every digital Act, so routing on text alone would send them to Chandra. Sinhala FM-font PDFs go to docling (FM → Unicode conversion happens later, during post-processing).
- **The two raw shapes differ by design:** docling uses PDF points with origin bottom-left, gives cells plus regions, and plain text. Chandra uses image pixels with origin top-left (e.g. `[0,0,1588,2245]`), gives blocks only, and HTML text. Step 2 is **one adapter per engine** into a single common block shape; everything downstream reads only that shape.
- Parsing (sections, schedules, labels) is a separate, cheap, repeatable step and never edits the raw files.

**Step 2 is built:** `etl/extract.py`. Queue = unique `sha256` with `r2_key` set and `raw_key` NULL. It counts text-layer chars and image objects per page with pypdfium2 (≥20 chars = digital; <20 chars + image = scan; neither = blank) and runs docling on the whole file if any page is digital (OCR off, `generate_parsed_pages=True`, `keep_empty_clusters=True`, **docling_parse backend** with pypdfium fallback). Scan pages go to Chandra (`prompt_type="ocr_layout"`, via vLLM). Output: `raw/v2/<sha256>.json.gz` = `{pages: text-layer counts and sizes, docling: {document, pages[parsed_page, predictions]}, chandra: {pages[raw, token_count, image_size], params}}`. Written only if every page succeeded. **Not yet run anywhere:** the docling serialisation (`model_dump(mode="json")` of parsed pages and predictions) and the Chandra call are untested until the ada pilot. Chandra's `raw` is the model's HTML with `data-bbox` on a 0–1000 grid of the rendered image (`settings.BBOX_SCALE`); its bundled `chandra_vllm` launcher uses `sudo docker`.

**Step 1 is built:** `etl/fetch.py` (+ `migrations/001_documents.sql`). It upserts one row per (act, language) file with the listing record verbatim in `meta.listing`, then archives each file to R2 `source/<sha256>.pdf`. Its queue is `r2_key IS NULL`. The 1,268 existing rows match the spider's URLs exactly (checked 2026-10-04), so discovery merges into them rather than duplicating.

## Pilot findings (ada, 2026-10-04)

- **Fetch:** all 4,002 Act files are in R2, with 0 failures. Sequential fetch ran at 2.8 s/file; with 8 workers and batched Neon writes it was ~0.2 s/file. Pre-2000 scans are 1–7 MB each.
- **docling backend:** `pypdfium` stores **line cells only, with no fonts and 0 word cells** (that was raw v1, 20 files). `docling_parse` stores **word cells with `font_name`** (e.g. `/TimesNewRomanPS-ItalicMT`), and took 107 s for a 589-page Act versus 83 s for pypdfium. Raw v2 uses docling_parse and falls back to pypdfium only if docling_parse raises or finds no cells on a text page. Neither backend stores char cells (`chars=0`).
- **Sinhala text layers:** the 2026 Sinhala Act (12/2026) is **Unicode** (font `IskoolaPota`); the 2010 one is legacy FM. Exactly which years use FM is not measured yet.
- **Chandra speed:** GPU 0 shared with a 100%-busy job gave **~47 tokens/s**. Idle GPU 2 gave **470–690 tokens/s** with 16 concurrent pages, i.e. 0.58 pages/s on a 34-page Act (29k tokens). One file per batch leaves slots idle on short Acts.
- **Chandra output:** every block has `data-bbox` (0–1000 grid) and `data-label` (Text, Section-Header, List-Group, Page-Header, Page-Footer, Table, Image). **Marginal notes are captured** as separate blocks in the side column, y-aligned with section openers. But **spaces are lost where a note wraps** ("theconduct ofbusiness", "Delegationof powersof theBoard"). That is in the model's output, and we can't fix it on our side.
- **Chandra Sinhala (1981 scan):** real Unicode, mostly readable, but with misreads ("සාර්ථිමේන්තු" for "පාර්ලිමේන්තු"). Accepted as an engine limit (decision 2026-10-04).
- **ada setup facts:** no `sllaw` conda env and no passwordless sudo (so no docker launcher). Port 8000 is taken by another user, so Chandra runs on 8011 (`VLLM_API_BASE=http://localhost:8011/v1`). The vLLM venv (11 GB) and Chandra weights (16 GB) live in `/tmp/e19309` and are lost on reboot.

## OCR scope (measured, all 1730 acts)

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

`legacy/ocr_results/out/engines_summary.json` already ranks engines: rapidocr 33.6s,
easyocr 98.9s, surya 750.5s for comparable output. Surya costs 22x for 22% more
characters. The hard part is not recognition — `parse.pdf` binds marginal notes by
y-position from pypdfium2, so an OCR path needs an adapter presenting the same
(x, y, text) geometry before `build()` can consume it.

## Validation rules: what holds and what doesn't (tested 2026-10-04)

Several "self-checks" were proposed as a way to verify extraction without reading documents. They were tested against the 890 parsed Acts in the DB (`documents` with status `qa_pass`/`qa_flagged`, 27,953 chunks). **Do not re-propose a rule marked wrong without new evidence.**

| Rule | Verdict | Evidence |
|---|---|---|
| "Sections run 1..N; a missing number means a missing section" | **Wrong as a check** | 118/890 Acts (13%) have gaps, equally in amending (12%) and principal (14%) Acts. Of 238 missing numbers, 75 appear as openers inside **quoted substituted text** (17/2026 s.3 and s.27 after "the following section is substituted therefor") or **numbered schedule lists** (34/2022 Seventh Schedule item 1; 19/2022 list of Ordinances, items 28 and 29). The other 163 aren't in any chunk; whether lost or never present can't be told without the PDF. Quoted numbers can also *fill* a real gap and hide a loss. The rule only works once quotes and schedules are fenced off, which is the extraction problem itself |
| "Every section has a marginal note" | **True but useless as a correctness check** | 96% of sections that open with their own number have a note (604/15,778 don't). But presence ≠ correct: 388/23,215 notes are letter-salad from overlapping glyphs (12/2005 s.3: "Magistrate's Ch g Court … ihdi j … i11 d g"), and notes bleed into the body text (12/2026 s.6 "Fund of the Authority") |
| "Longer Acts open with an Arrangement of Sections" | **Unverified** | 0/890 Acts have one in their chunks, but the parser deliberately skips the pages before the body (TOC/index guard), so the DB can't show it. Needs a check against the PDFs on ada |
| "The three language versions have the same sections" | **Unverified, and unusable now** | Most Acts from 1980–98 have only one language. Sinhala is scans or legacy FM font, so it can't be parsed to compare |
| "~390 Acts have a lankalaw consolidation to compare against" | **Wrong** | The 2024 collection (85 HTML + 304 PDF) is *consolidated statutes*: the principal enactment with later amendments merged in, many of them pre-2006 Ordinances. It differs from the as-enacted Act by design whenever the Act was amended |
| "Acts since ~2000 share one template" | **Partly wrong** | Page size changed from 384×552 to A4 between 2003 and 2010 ([LAYOUT.md](LAYOUT.md)). Appropriation Acts are financial tables, not text Acts |

**`qa_pass` does not mean correct.** The gate tolerates `max(3, 10%)` numbering gaps, so Acts with known losses pass: 12/2026 (6+ missing sections, including 165, 221 and 226) and 17/2025 (sections 1–3 missing) are both `qa_pass`.

**Open problem:** no automatic check proves an Act was extracted correctly. Every rule above either depends on the extraction it is meant to verify (quotes and schedules) or measures presence, not correctness. Until there is one, correctness needs a hand-checked sample: real Acts compared section by section against the PDF.

## Element census (2026-10-04)

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
