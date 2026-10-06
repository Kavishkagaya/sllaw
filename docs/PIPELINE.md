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

**Decision (2026-10-04, user): structuring is code-based and English-only.** The decision models (Jev, Clef) were not adopted; see below. Sinhala and Tamil are not structured: when a task needs them, the whole Act is given to an agent. The English structure is for search, Q&A and citation (Act → sections with number, note and text; quoted amending text stays inside its section). The amendment graph and consolidation would need more and are deferred.

**Year sweep (2026-10-04):** 24 more English Acts from 2009–2014 (4/year, unseen) added to the 2013–2026 set; 68 runs in all, 55 with zero warnings. Fixes that came from it:
- A numbering jump is only accepted as a section if its opener has an unquoted marginal note (8/2012: items 33–40 of an inserted rates schedule, whose closing quote sits in the rate column).
- A second enacting formula after sections have started means the PDF holds the Act twice; the repeat is dropped (1/2010, pages 6–9 repeat 2–5).
- **Appropriation Acts are flagged, not structured** (7/2010, 20/2010, 23/2025: notes mixed into the body, labels split off, a budget schedule with no detectable heading).

**Correctness check (2026-10-04), 63 English Acts 2009–2026, Appropriation Acts excluded:**
- **Text kept:** every non-furniture block after page 1 is found verbatim in the output, after removing only the section number, paragraph labels and Part/Chapter lines that are stored as structure. 0/8,805 blocks are missing, and no text is duplicated (word-count check against docling's own text lines). `act()` now runs this check on every Act and warns first if anything is missing; it flags all three Appropriation Acts (5–278 blocks).
- **Text in the right place:** all 64 "Short title" notes are on s1; 284/284 "Amendment/Replacement/Repeal/Insertion of section N" notes sit on a section whose text names section N; no section opens mid-sentence. 14 random sections were read in full: 12 were right, and 2 had a running-header fragment in the last section (fixed).
- **Fixes from this check:**
  - Line-end hyphens are kept: they are compounds ("non-governmental"), not word splits.
  - A mixed-case "SCHEDULE (Section 2)" heading is now found; 29/2018's Convention had gone into s9.
  - The body edge is taken only from lines wider than 100 pt; 26/2018 s4 had been read as a margin note.
  - Nesting comes from whichever of Part/Chapter appears first; 5/2015 has Chapters holding Parts.
  - Cross-headings are kept as `heading` on the sections that follow them.
  - A section number split from its first line by docling is merged back (6/2026 s25).
  - A running title printed over two lines is treated as furniture (5/2009, 22/2022, 28/2022).
- **Known limit:** an inserted section's own quoted note inside the body column stays in its text ("…shall consist of :- 'Composition of Municipal Councils.", 21/2012). It only affects quoted text.

Not covered yet: 2000–2008 (384×552 booklet format, extraction still running on 2026-10-04) and anything before 2000 (scans → Chandra; no Chandra raw exists yet, and no Chandra adapter).

**Step 3 is built (English, docling only):** `etl/structure.py` (`python3 -m etl.structure raw.json.gz … --out DIR`; self-check `python3 -m etl.test_structure`). `blocks(raw)` is the docling adapter: one block per layout cluster with `page, bbox (pt, top-left), label, role (body | margin | furniture), text`. `act(blocks)` gives `{title, number, year, certified, long_title, preamble, enacting, front, sections[{num, note, part, chapter, pages, paras[{label, text, page, quoted?, rows?}]}], schedules[{heading, paras}], warnings}`. It runs locally on downloaded raw JSON only; there is no R2/Neon batch runner yet. Rules that came from failures (2026-10-04):
- **Margin column:** justified body lines end at the column's right edge R (most common line end, per page parity), and the body is **240 pt wide in every format**, so L = R − 240. Measuring L directly failed: short amending Acts have few full-width lines, and inserted sections bring indented text plus their own quoted note *inside* the body column (31/2022). Coverage histograms failed when a long full-width schedule swamped the notes (29/2018). docling merges note and body into one cluster (and sometimes one line cell); the split is per line cell.
- **Quote fence** (amending Acts): a quote opens on a leading quote mark, or after amending wording ("…substituted/inserted… the following …:-"; 22/2017 printed no opening mark). It closes on a quote mark followed by punctuation at block end, or `'.`/`';` mid-block (8/2014). A short quoted term followed by lower-case prose (`'bank' means`, `'executive' when used`, `'public finance 'includes`) is a definition, not a quote. An unclosed quote ends at the next section number level with an unquoted marginal note, with a warning (31/2022 never prints the close).
- **Section openers:** `N.` must be > the last number and ≤ last + 10; `12A` only straight after `12`. A body line starting `N.` level with a note line starts a new block even inside one docling cluster (a whole-page `form` cluster, 31/2022), and a bare `23.` cluster joins the next block (5/2015).
- **Measured:** 41 distinct English Acts (2013–2026; 20 tuning + 20 holdout + Anti-Corruption 9/2023): every section number 1..N found in all 41. 35 runs had zero warnings. Left over: 3 informative "unclosed quote ended" warnings, missing notes in 24/2013 s5 and 5/2026 s1 (one-page body; docling's line cells span note and body, so splitting needs word cells), and stray margin fragments in 26/2018 and 6/2026. Correct counts ≠ correct text: content was checked by eye on Anti-Corruption, VAT 32/2023 and Notaries 31/2022 only.
- **Not handled:** Appropriation schedules (landscape financial tables; docling's grid is garbled), schedule item splitting, nested paragraph tree (paras are flat with labels), Chandra raw (scans), Sinhala/Tamil (legacy fonts below).

## Step 4: amendment graph and point-in-time walk (built and tested locally 2026-10-04, not run on Neon)

**Decision (user, 2026-10-04): no consolidated texts. At query time, retrieval walks the graph** from the section asked about to every later change dated up to the year asked, and hands the original plus those changes, in order, to the reader (an LLM).
- `etl/graph.py build` structures every extracted English Act (raw from R2) and writes Neon tables `acts` (whole structured JSON in `doc`), `sections` and `edges` (`migrations/002_graph.sql`). Structured output lives only in Neon; there is no R2 copy, because rebuilding from raw takes seconds. `--local DIR` builds from raw files on disk (testing).
- `etl/graph.py walk 14/2002 22 --year 2023` returns the original section (if that Act is structured) and every amends/replaces/repeals/inserts edge into it, plus repeals of the whole Act, dated by then. Each change carries its `new_text` (the quoted words) and the whole amending section (the instruction).
- **Every retrievable part of an Act is a row in `sections`**, with `kind`:
  - `section`: num `12A`.
  - `schedule`: num `First Schedule` / `Schedule A` / `Schedule`, the same name amendment notes use, so a walk on "First Schedule" finds both the original and its amendments; `note` holds the schedule's "[Section 41]" / "(sections 5, 6 and 9)" reference; table rows are kept as `a | b | c`.
  - `preamble`: long title, WHEREAS clauses, enacting formula.
  - Cross-headings go in a `heading` column. Appendices/Annexes: none were found in Acts (element census); forms sit inside schedules.
  - On the 66 test Acts: 1,195 sections, 66 preambles, 5 schedules, 21 edges into schedules.
  - A schedule heading printed inside a table ("SCHEDULE I" + age table, 28/2021) is now found.
- **Edges are read from the long title, marginal notes and citations; no model is involved.** Node keys: `act:14/2002`, `law:1/1975`, `ordinance:N/YYYY`, `cap:107` (pre-1980 Ordinance chapters; stub nodes until their text is in the corpus). A note without its own target means the principal enactment, which is defined once ("hereinafter referred to as the 'principal enactment'").
- **Measured on the 66 test Acts** (local Postgres via `pgserver` under Python 3.12 from `uv`; Docker needs sudo here): built in 19 s with 0 failures; 1,195 sections; 692 edges (251 amends, 57 inserts, 21 replaces, 5 repeals, 31 amends_act, 7 repeals_act, 320 cites). Every one of the 314 change notes produced an edge. Spot checks were right: VAT 14/2002 s22 gets 9/2011, 7/2012, 19/2019 and 32/2023, filtered by year; Judicature 2/1978 s12A comes from 9/2018 s2; 9/2023 s163 repeals Chapter 26, Law 1/1975 and Act 19/1994.
- **One law, two names (`same_as`):** pre-1980 laws are cited both by number and by their 1980 Revised Edition chapter ("School Teachers Pension Act, No. 44 of 1953" = "Chapter 432", 32/2008). A `same_as` edge (dst_act + evidence "also cap:432") is recorded when the two citations stand side by side, or when the long title names exactly one law and the principal enactment calls it by its chapter. `walk` expands to every name. The single-law guard is needed: 21/2012's long title names two Ordinances without numbers plus Act 15/1987, and an earlier version wrongly made 15/1987 = Chapter 252. On 98 test Acts: 1 alias, and it is correct. The principal-enactment definition is matched with any quote style ('…', "…", “…”).
- **Commencement (`acts.commenced`, `acts.commencement`):** read from s1 or a section noted operation/commencement/retrospective; only the Act-wide sentence counts. Kinds: `date` (comes into operation on a stated date), `deemed` (retrospective), `certified` (on the Speaker's certificate), `appointed` (on a date set by Gazette Order: not in the corpus, so the certified date is used and the walk adds a `date_note`), `unstated` (in force from certification, the constitutional default, Art. 80). Edge dates are the commencement date. On 98 test Acts: 83 unstated, 9 appointed, 5 deemed (e.g. VAT 9/2011 certified 2011-03-31, in force 2011-01-01), 1 date (8/2012, 2012-04-01).
- **Amendments of amendments:** each change in a walk carries `amended_by`, the later changes to the amending section itself (up to 3 levels, same year filter). Tested with temporary rows: the 2025 change shows under the 2023 one only when walking as of 2025.
- **Limits:**
  - Commencement of individual provisions (a proviso bringing one section in earlier or later) is not read; only the Act-wide date.
  - Amendments of amendments are not followed.
  - When one section inserts several sections, all of them get the same `new_text`.
  - Targets before 2009 have no `original` until those Acts are structured.

## Decision models for block labelling (surveyed 2026-10-04)

**Decision (2026-10-04, user): Jev via Vercel AI Gateway; Clef rejected.** `etl/label.py` is built but **not run yet: no `AI_GATEWAY_API_KEY`**. Split of work: `etl/structure.py` keeps the geometry (`blocks()`: body/margin split, indent, furniture) and the assembly (`assemble()`: numbers, paragraph labels, notes by alignment, gaps). Both labellers produce one label per body block from the same set (`KINDS`): the rules (`rule_kinds()`, output byte-identical to before the split on all 41 Acts) and Jev.
- **Questions per block** (atomic, because Jev answers each one independently): `t` type (choice of 9), `q` quoted-by-an-amendment (yes/no), `c` continues the previous sentence (yes/no). Code maps them to `KINDS` (type + quoted → `quoted`).
- **Requests:** POST `https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`, `zeroDataRetention`. 20 blocks (60 questions) per request. Its state carries 12 blocks before (with Jev's labels so far) and 4 after; windows within an Act run in order, Acts run in parallel. Dry run: about 12k tokens per request, mostly the 9 type definitions repeated per block; Anti-Corruption 9/2023 = 59 requests, about 0.7M tokens.
- **Pass 2:** blocks where Jev ≠ rules or Jev is unsure (confidence or P < 0.8, or quoted P between 0.2 and 0.8) are re-asked with their neighbourhood, using a gateway conditional fallback to a language model (`FALLBACK`; slug unverified) for answers that stay uncertain. Jev's final label is used; blocks still differing from the rules are counted per Act in `labels.json`.

| | Jev (TypeSafe AI, released 2026-09-15) | Clef / Clef-flash (Cloudflare, released 2026-10-01) |
|---|---|---|
| Weights | closed, API only (`jev-latest`; Pydantic AI has a client, `TYPESAFE_API_KEY`) | **open, Apache 2.0**: HF `Cloudflare/clef` (27B, Qwen-based), `Cloudflare/clef-flash` (9B); Workers AI `@cf/cloudflare/clef(-flash)` |
| Request | state + typed questions (choice ≤255 options, score ≤10 levels, yes/no), answered in parallel and independently | same format as Jev (REST wraps answers in `result`); ≤64 questions/request; up to 4 images/request |
| Context | ~32k state (64k request) | 64k |
| Price | $0.042/M input, output free | $0.24/M (clef), $0.09/M (flash); free if self-hosted |
| Self-host VRAM | n/a | flash ≥41 GB (fits one ada card), clef ≥85 GB (two cards); `transformers` only, no vLLM recipe published |
| Accuracy claims | own index: 67.8% aggregate; can't do arithmetic or counting | self-reported, not reproduced: BANKING77 94.2 vs Jev 79.7, MMLU-Pro 65.9 vs Jev 82.7 |
| Sinhala/Tamil | not documented | not documented |

Questions in one request can't see each other's answers, so cross-block state (open quote, last section number) has to be in the state text. Sources: gradually.ai/en/ai-models/jev, pydantic.dev/docs/ai/models/typesafe.md, layer3labs.io/guides/jev-limits, flaviocopes.com/clef, dev.classmethod.jp/en/articles/cloudflare-clef-overview, theregister.com 2026-10-01.

**Clef measured (2026-10-04, Workers AI direct, `etl/label.py --provider cloudflare`).** Pass 1 used clef-flash and pass 2 used clef on doubtful blocks; 38 English Acts (3,968 blocks), $1.04, about 4 min with 8 Acts in parallel.
- **Section lists:** identical to the rules on 31/38 Acts. In all 7 misses Clef is the one that's wrong (the rules' lists were checked complete): real sections lost (VAT 32/2023 s5, 28/2022 s9, Notaries 31/2022 s22), quoted inserted sections taken as real (8/2022 161I–161M, 8/2014 59G–59H, 17/2017 58B), and one duplicate (29/2018).
- **Blocks:** 63.1% agree with the rules on pass 1, and 11.1% still differ after pass 2. The biggest confusion is quoted → section_text (179 blocks): Clef doesn't keep track of a quote opened earlier. clef-flash gave P(quoted) of only 0.34–0.45 on blocks starting with `'Provided that`; clef (27B) fixed those in pass 2, but in VAT it also turned s5 into schedule text.
- **Takeaway:** Clef is good at what a block looks like locally and weak at long-range state. Next idea, not tried: ask only local questions ("does this block open a quote?", "does it close one?", "does it start a schedule of this Act?") and keep the state machine in code.
- **Blockers hit:** Vercel AI Gateway: first a 403 card check (cleared by itself after the card was added), then "free tier users do not have access to this model" for Jev (needs paid credits). Workers AI: Python's default User-Agent gets error 1010; Cloudflare AI Gateway `axon_gateway` gave 401 with a Workers-AI-template token; the free daily limit of 10,000 neurons ran out after about 37 Acts (Workers Paid plan needed).

## Chandra runaway pages (2026-10-06)

Some scanned pages make Chandra repeat a phrase until it reaches `MAX_OUTPUT_TOKENS` (default 12,384), and the client then retries. On the 1990s lankalaw scans: 269 retries for 516 pages, and 3–9-page files taking 2,100–4,400 s, because the runaways held the server's 16 slots while short pages queued. Workers now run with `MAX_OUTPUT_TOKENS=5000` (a dense page with HTML and boxes is about 2–3k tokens) and `MAX_VLLM_RETRIES=1` (`etl/ada_setup.sh`, `CHANDRA_MAX_TOKENS`). Each raw records the values in `chandra.params`.

**ada setup facts (2026-10-06):** ada rebooted on 2026-10-05 at 09:40 UTC after a CUDA "unspecified launch failure" killed the Chandra engine at 08:31; `/tmp` was wiped. `etl/ada_setup.sh` rebuilds everything. The NFS home stalled three things: imports from `~/sllaw/.venv`, docling's model cache, and vLLM/torch/flashinfer compile caches (Chandra answered nothing for 50+ minutes). All of them now live in `/tmp/e19309` (`~/.cache/{vllm,torch,flashinfer,docling}` are symlinks there).

## lankalaw.net Acts and HTML documents (2026-10-05)

**Scope decision (user, 2026-10-05): extract English only.** `etl.extract` defaults to `--lang ENGLISH` (`--lang all` for everything). That left 664 Sinhala/Tamil files queued, about 15 GPU-hours of Chandra scans that the English-only graph doesn't use. When the queue runs out, extract looks again, so files fetched meanwhile are picked up; each file is tried once per run. Rate on the shared GPU 2: about 40–50 scanned files an hour.

**Scope decision (user, 2026-10-05): 1980 onwards only for now.** Pre-1980 law (lankalaw 1956–79 year pages, 612 files; the 1980 Revised Edition, 516 chapters) is not fetched; edges to it stay dangling and `missing` reports them.

**Decision (user): fill documents.gov.lk's gaps from lankalaw.net year pages** (`etl/spiders/lankalaw.py`, `etl.fetch lankalaw`). Only rows for an Act with no English file from documents.gov.lk are fetched. Listing on 2026-10-05: 2,621 files (1,749 PDF, 872 HTML). 1,277 duplicate what we have and are skipped; **1,344 fill gaps**: 427 Acts listed without English, 612 pre-1980 Acts and Laws by number (1956–79), and 305 Acts from 1980–2009 missing from the listing. `doc_date` is 1 January of the year (`meta.date_precision = "year"`) until the Act's printed date is read.
- **HTML Acts:** `fetch` stores them as `source/<sha256>.html`. `extract` keeps the page itself in `raw.html` (`format: "html"`) plus docling's HTML conversion. The page is kept because its rows pair each note with its section.
- **Layout (every era 1962–2004):** a section is one table row: a narrow cell (80–100 px) with the marginal note and a wide cell with the text; subsections are nested rows of the same shape. Pages from 1988 on add classes (`actname`, `descriptionhead`, `sectionshorttitle`, `sectioncontent`, `subsectionshorttitle`); 1962–75 pages have none.
- **`structure.html_rows()` / `html_pages()`:** rows → docling-shaped pages (note in the margin, text in a 240 pt column at the same height, 16 pt apart so notes never merge), so `blocks()` onwards is unchanged. Handled:
  - layout cells split at block elements, so title, long title and enacting formula don't run together;
  - "2." with its text in a nested row is joined to that row;
  - a note starting with a quote mark is an inserted section's own note and stays in the quoted text;
  - a subsection's note ("Cap. 235.") is kept in place as a line of text;
  - `<head>` is skipped;
  - a date printed as "[ 17th December , 1988 ]" is the certified date;
  - the title falls back to the Act's name (HTML only).
- **Tested** in memory on ada with 6 real pages (1962, 1971, 1975, 1988, 1996, 2004): sections with notes 10/10, 2/2, 14/14, 13/13, 6/7, 11/11; dates found where printed (1988 onwards); 1962–75 pages print no date and 1962 no enacting formula (correct warnings). The PDF Acts' output is unchanged (0 of 101 differ).

## OCR-layer scans: router fix and in-place re-extraction (2026-10-04)

**Finding:** many 2008 PDFs are scans with someone else's OCR text layer: one image per page plus visible text (render mode 0) in fonts the OCR tool made up, named like `*Minion Pro-21633` (docling reports them as `/*Minion Pro-21633`). The old router saw ≥ 20 characters and sent those pages to docling, so the raw held the poor embedded OCR ("Sri Rath11t1jotlzi Com1111111ity"). The 2008 sample (22 English Acts) split into 3 born-digital A4, 10 pure scans (Chandra, fine) and 9 with an OCR layer (wrong). The `*` font test separated them exactly: 100% of words in `*` fonts in all 9, 0% in 23 born-digital files (2008–2023). Render mode does not separate them.

**Fix (`etl/extract.py`):** `text_layer()` records `ocr_layer` per page (more than half of its text objects in `*` fonts). `is_scan()` = has an image and (fewer than 20 characters, or an OCR layer). Such pages go to Chandra; docling still runs on the file's born-digital pages.

**Recovery (decision 2026-10-04, user): no v3; fixed in place.** `python3 -m etl.extract --recheck-ocr` reads every v2 raw and clears `raw_key` for files where an image page with a `/*`-font layer did not go to Chandra. The next run re-extracts them over the same `raw/v2/<sha256>.json.gz`. This is an exception to "written once": v2 files of re-queued Acts were overwritten. On the samples it flagged exactly the 10 OCR-layer files and none of 91 others. The run on ada was stopped at 1,846/3,980 (2008 reached) and restarted as recheck + extract in tmux `fix`.

**Chandra adapter (`etl/structure.py`, `chandra_pages()`):** turns Chandra's per-page HTML (`data-bbox` on a 0–1000 grid, `data-label`) into docling-shaped pages, so `blocks()` handles scans, digital pages and mixed files the same way. A block with several `<p>`/`<li>` becomes one cluster each. Scanned pages get their own body column, because the scanner shifts each page (31/2008: body ends at x 290 on p2 and 356 on p3). Chandra sometimes writes a marginal note inside the body block as `<span style="float: right;">Short title.</span>`; the adapter splits those out into the margin and trims the body block to the 240 pt column (32/2008 had 0 notes before this). A scanned page needs only one note block to place its margin (docling needs 2 lines). "11 (1) The Corporation …" (dot lost in the scan, 30/2008) is accepted as an opener only for the next number with its own note. After these fixes, 11 pure 2008 scans: 8 have no warnings; 40/2008 has 92/92 sections and 91 notes; 31/2008 lacks s22, and the printed Act really skips it: Chandra's layout and plain-OCR modes both give page 21 ending mid-sentence in s21(2), page 22 continues s21(3)–(8), and page 23 opens with s23 (checked 2026-10-04) and has one paragraph Chandra boxed as 13% of the page width, which was taken for a note.

## Pilot findings (ada, 2026-10-04)

- **Fetch:** all 4,002 Act files are in R2, with 0 failures. Sequential fetch ran at 2.8 s/file; with 8 workers and batched Neon writes it was ~0.2 s/file. Pre-2000 scans are 1–7 MB each.
- **docling backend:** `pypdfium` stores **line cells only, with no fonts and 0 word cells** (that was raw v1, 20 files). `docling_parse` stores **word cells with `font_name`** (e.g. `/TimesNewRomanPS-ItalicMT`), and took 107 s for a 589-page Act versus 83 s for pypdfium. Raw v2 uses docling_parse and falls back to pypdfium only if docling_parse raises or finds no cells on a text page. Neither backend stores char cells (`chars=0`).
- **Sinhala text layers:** the 2026 Sinhala Act (12/2026) is **Unicode** (font `IskoolaPota`); the 2010 one is legacy FM, and so is **9/2023** (`FMAbhaya`, numbering prints as `1'` and `^1&`). Exactly which years use FM is not measured yet.
- **Tamil text layers are legacy too:** 9/2023 Tamil uses `GPRasanji` (Bamini-style), not Unicode. Both languages need font→Unicode conversion before `etl/structure.py` can read them; their layout is the same two-column one.
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
