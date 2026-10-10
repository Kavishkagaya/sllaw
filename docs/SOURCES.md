# Sources

Where Sri Lankan law lives online, how to reach it, and what blocks us.
Surveyed 2026-10-04. Re-check a source only if its row says something changed.

## Scope

The goal is the law as it stands now. Phases, in order:

| Phase | What | Why | Source |
|---|---|---|---|
| 1 | **Constitution** | Supreme law. Numbered by Articles and Chapters, not Sections and Parts | Base 1978 text: lankalaw "Core Legislations" (not yet checked). Amendments 17th–22nd: documents.gov.lk act `0/YYYY` |
| 1 | **Consolidated statutes** | The starting text everything else applies to | 2006 consolidation now (already scraped); 1980 Revised Edition later |
| 1 | **Acts** | New law and amendments since the starting text | documents.gov.lk (2006+, complete in English) |
| 1 | **Regulations** | Binding law that exists only in gazettes (tax rates, import rules, emergency regulations) | documents.gov.lk extraordinary gazettes, filtered by description |
| 2 | **Judgments, SC decisions on Bills** | Explain the law but don't change its text | supremecourt.lk, courtofappeal.lk, parliament.lk |
| — | Bills, Hansard, provincial statutes | Low value or scattered | Later, if at all |

Model: starting text (a consolidation) plus Acts after it as amendments, checked against the 2024 consolidation.

**Tamil is out of scope (user, 2026-10-06).** All 1174 Tamil `documents` rows (702 MB of PDFs, 978 with raw extraction) were deleted from Neon and their 2150 R2 objects removed; `etl.fetch acts` no longer lists Tamil files. One Tamil file had the same sha256 as a non-Tamil row, so its R2 objects were kept. To bring Tamil back, drop the filter in `discover_acts` and re-run fetch.

## Open datasets (surveyed 2026-10-04)

Use these before scraping. They are already downloaded mirrors, served from GitHub raw or Hugging Face with no rate limits or Cloudflare.

### nuuuwan/lk_datasets: 26 datasets, updated daily (MIT, arXiv:2510.04124)

Index: `https://raw.githubusercontent.com/nuuuwan/lk_datasets/main/README.md`. Each document is a folder `<id>/` holding `doc.json` (metadata), `doc.pdf` and `doc.txt`; each dataset has a `docs_all.tsv` index.

| Dataset | Repo / branch | Docs | Range | Use for us |
|---|---|---|---|---|
| Acts | `lk_legal_docs` / `data_lk_acts` → `data/lk_acts/<decade>/<year>/` | 3,979 (en 1,229 · si 1,567 · ta 1,183) | 1981–2026-04 | **PDF mirror** of the old documents.gov.lk `/view/` URLs |
| Bills | `lk_legal_docs` / `data_lk_bills` | 4,236 | 2010–2026-04 | PDF mirror |
| Extraordinary gazettes | `lk_legal_docs` / `data_lk_extraordinary_gazettes_2010s` and `_2020s` | 56,379 + 49,513 (all languages) | 2010–2026-04 | PDF mirror; only 28% of the 2020s set has a PDF |
| Supreme Court judgments | `lk_supreme_court_judgements` / `data` | 2,729 (70% have a PDF) | 2009–2026-05 | **Use instead of scraping supremecourt.lk** |
| Court of Appeal judgments | `lk_appeal_court_judgements` / `data` | 18,551 (78% have a PDF) | 2010–2026-09 | **Use instead of scraping courtofappeal.lk** |
| Hansard | `lk_hansard` / `data_lk_hansard_2020s` etc. | 280 | sparse before 2023 | Low priority |
| Cabinet decisions | `lk_cabinet_decisions` / `data` | 11,126 | 2010– | Policy context, not law |

**Acts coverage vs documents.gov.lk** (compared by act number + language from both indexes, 2026-10-04): 3,835 files in both. **167 are only on documents.gov.lk**: the 1980 acts (lk starts in 1981) and everything after 2026-04. **144 are only in lk**: files the old site had that the new listing drops. Use both.

**Not in lk_datasets at all:** lankalaw consolidations (2006, 2024, 1980 Revised Edition), the 1978 Constitution base text, SC decisions on Bills, provincial statutes.

**Text quality:** `doc.txt` is just the PDF's text layer, with **no OCR and no font fixing**. Before ~2000 it is empty (scans). Sinhala is still in the broken legacy FM font (`YS% ,xld`). So it saves downloading but not text extraction. The legal_docs branches stopped updating in 2026-04, when documents.gov.lk moved.

### Others

| Resource | What | Notes |
|---|---|---|
| **SinhaLegal** (GitHub Minduli-Lasandi/SinhaLegal, HF `Minduli-Lasandi/SinhaLegal`, arXiv:2603.04854) | 1,065 Sinhala Acts (1981–2014) + 141 Bills, **OCR'd with Google Document AI and post-processed** | **The only clean pre-2000 Sinhala text.** Covers the OCR gap for free. No licence file |
| **Sri-Lanka-Case-Law-Dataset** (GitHub NavodPeiris, CC-BY-4.0) | NLR, SLR, CLR, CLW law report entries: case no, citation, court, title, summaries, date, judges | Partly fills the subscription-only law-reports gap. Row count not checked |
| LawChain (ICML 2026, U. Moratuwa) | Claims to release a 22,812-node graph and 26k Q&A pairs | **No public download found** (not on GitHub; the ICML and project pages have no link; OpenReview needs a login). Ask the authors (Nisansa de Silva, UoM) |
| U. Peradeniya "AI legal chain resolver II" | Neo4j graph code | **Hand-written** Cypher for one Act (Consumer Affairs Authority Act No. 9 of 2003). Nothing reusable |
| Other GitHub repos ("sri lanka legal": ~13 hits) | Student RAG demos | Not reviewed individually; none has stars or data of note |

## Prior art (surveyed 2026-10-04)

How others build legal knowledge graphs. Only abstracts and project pages were read; no code was checked.

| Who | What | How the graph or amendments are built |
|---|---|---|
| LawChain (Atukorala, Appuhami, de Silva, ICML 2026) | Search over Sri Lankan Acts: keyword + embeddings + Neo4j graph (22,812 nodes) + 26k Q&A pairs, all released | Method not stated in the abstract. **Check this first**: the graph and Q&A set may be reusable as-is |
| U. Peradeniya final-year project "AI legal chain resolver II" (2026) | Sinhala retrieval + graph + multiple agents | Not stated; GitHub: cepdnaclk/e20-4yp-AI-legal-chain-resolver-II |
| lankalaw.net AI assistant, AI Pazz, Iuris Scientia | Commercial Sri Lankan legal AI | Closed |
| legislation.gov.uk (UK National Archives) | Point-in-time versions of all UK law | An **editorial team** records every change ("effects") and applies it. Changes not yet applied are listed against the provision |
| Laws.Africa / Indigo | Open platform, Akoma Ntoso XML, many African countries | **Editors** apply amendments in a tool; each amendment creates a new version of the document |
| Etcheverry, Real, Chavallard (arXiv 2501.16794) | Applying amendments to French law automatically | Small LoRA-tuned model; **about 63% success** on a hard bill |
| Lexis (Shepard's Knowledge Graph), Westlaw (KeyCite) | US case law and statutes | Decades of editorial citation tracking; Harvey licenses Lexis rather than build its own |

Conclusion: nobody gets a reliable amendment graph from AI alone. The big players use deterministic structure, people for the hard cases, and the graph as the product. Fully automatic amendment application is still around 63% in research.

Measured here: of the 742 Acts since 2006, **373 (50%) are amending Acts by title** ("X (Amendment) Act"), so the title alone links each one to the Act it amends.

## Authority

- From 1978, laws are enacted in Sinhala and Tamil with an English translation (Constitution Art. 23). Acts say "the Sinhala text shall prevail", so **Sinhala is authoritative for law from 1978 on**.
- Ordinances from before 1978 were enacted in English, so English is the original there.
- Law text is not copyrighted (Intellectual Property Act No. 36 of 2003, s.8). Editorial consolidations (lankalaw) are grey: take the law text, not the site's own arrangement.

## documents.gov.lk (Government Printer)

A Next.js app. Every listing is one Server Action (`TableDataAction`) called with a different `apiEndpoint`. `etl/spiders/acts.py` already handles this; for another section, change `PAGE` and the endpoint.
Files: `https://documents.gov.lk/api/content-file-proxy?file=/<uploadedFile>`.

| Section | Page | apiEndpoint | Records | Years |
|---|---|---|---|---|
| Acts | `/web/acts` | `…/website-data/act/get-all` | 1,736 | 1980– |
| Bills | `/web/bills` | `…/website-data/bill/get-all` | 1,509 | 2003– (98% in all three languages) |
| Extraordinary gazettes | `/web/extra_gazettes` | `…/website-data/extra-gazette/get-all` | 38,867 | 2010– |
| Weekly gazettes | `/web/gazettes` | `…/website-data/gazette/get-all-gazette-dates` | 1,059 issue dates | 2006– |

`apiEndpoint` prefix is `http://gvp-api:4500` (internal host, passed through as-is).

### Acts coverage

| Period | Listed | With English PDF |
|---|---|---|
| 1980–1998 | ~741 of ~951 numbers | ~288 (~30%); 1985–89, 1991, 1994–96 have almost no English |
| 1999–2026 | ~990 | ~98% |

- 27 records before 1999 have no file at all.
- **2008 English PDFs are mostly scans** (sample of 22, 2026-10-04): 3 born-digital A4, 10 image-only scans at about 388–438 × 558–608 pt, and 9 scans carrying a third-party OCR text layer in `*`-named fonts, whose text is poor. 2009 onwards (sampled) is born-digital A4. 2000–2007 is not checked yet.
- Worst years (Acts listed vs highest act no., from Neon 2026-10-04): 1989 6/18, 1991 10/53, 1995 6/37, 1985 29/54, 1982 35/52. 1980: 56/62, English 54, Sinhala 26, Tamil 5. Gaps fill from lk_datasets (+144 files), SinhaLegal (Sinhala 1981–2014), and the 1980 Revised Edition for pre-1980 law.
- Constitution amendments are listed as act no `0/YYYY`, but only the **17th (Sinhala only) through 22nd**. The 1978 base text is not on this site.

### Blockers

- **Large pages:** past a few thousand rows, long strings are split into RSC `T` rows, and the `{"data"` row regex in `acts.search()` fails. Page at 5,000 or fewer, or regex over the raw body.
- **Rebuilds:** the Server Action id changes on every redeploy. `discover()` re-reads it each run; never hard-code it.
- **Paging:** upstream ordering is unstable across pages, so dedupe by `id`.

## lankalaw.net

Private site. robots.txt allows everything, and PDFs (`/wp-content/uploads/…`) download without a login.

| Collection | Path | Format | Notes |
|---|---|---|---|
| Legislative Enactments 1980 Revised Edition | `/legislative-enactments/ceylon-legislative-enactments-1980/` | One PDF per chapter (`sog93171.pdf` = Sale of Goods, Cap. 93) | Last **official** consolidation; the 1980 baseline. One HTML table lists everything: 519 rows with a PDF, **516 distinct PDFs**, chapter numbers up to 636, so chapters without a PDF exist (surveyed 2026-10-04). Spider: `etl/spiders/le1980.py`; `etl.fetch le1980`. **Fetched 2026-10-07: 516/516 PDFs, 0 failures, 107 MB** (about 26 KB/page; OCR text re-typeset as text-only PDF, see LAYOUT.md). **The listing is wrong in places:** the PDF listed as Telecommunications (521) prints Chapter 522 Thoroughfares; Special Areas (Colombo) Development (604) prints Chapter 628 Servicemen (Collection and Disposal of Specified Property); Customs Ordinance and Masters Attendant are both listed as 235 (Masters Attendant prints 235; the Customs PDF opens with its arrangement of sections, no chapter line). So Chapters 521 and 604 have no PDF here. Other mislinks not checked (only chapters whose page 1 prints "CHAPTER N" can be compared) |
| Legislative Enactments 1956, 1656–1956 | `/legislative-enactments/ceylon-legislative-enactments-1956/` | **One HTML page per chapter** (not PDF; corrected 2026-10-09) | **Surveyed 2026-10-09:** 481 chapters, all HTML (`1956Y3V75C.html` = Volume 3, Chapter 75; 12 volumes; chapters up to 481). Born-digital text, the same note | section table rows as lankalaw's Acts, a header listing the laws consolidated ("Ordinance Nos, 20 of 1884", "Act Nos, 22 of 1955") and a footer "Chapter 75, Volume No.3 Page No.192". **Its chapter numbers are not the 1980 edition's:** 203 = Motor Traffic (1980 cap 203 = Agricultural Products), 262 = Local Authorities Elections, 252 = Municipal Councils, 105 = Medical Practitioners…, 182 = Firearms, 117 = Registration of Documents, 19 = Penal Code. These are the `chapter:N` targets of 812 unresolved graph edges. Spider `etl/spiders/le1956.py`, `etl.fetch le1956`, graph key `cap1956:N` (fetched 2026-10-09, same terms decision as the pre-1980 Acts) |
| Consolidated statutes up to 2006 | `/consolidated-statutes-upto-2006/` | HTML, ~1,490 | Already in `consolidated_statutes` (legacy); the 2006 baseline. **Checked 2026-10-09 (listing only):** 1,490 HTML links, 0 PDF. Holds laws the graph misses: Transport Board Law (`1981Y16V526C-1.html`), The Board of Investment of Sri Lanka Law (`1981Y9V227C-1.html`), Metric Units (Consequential Provisions) Law 40/1978, LTTE proscription Law 16/1978, Indo-Ceylon Agreement (Implementation) Act (`1981Y10V249C-1.html`); not Criminal Procedure (Special Provisions) Law 15/1978 or Ceiling on Income Law 15/1972 (probably repealed by 2006). `1981Y<vol>V<chapter>C` names look like 1980 Revised Edition chapters in HTML (not confirmed); the text is consolidated to 2006, so it is a dated version, not an original. The 2024 consolidation page has 0 file links in its HTML (likely rendered by JavaScript; not checked further) |
| Consolidated acts 2024 | `/legislations/acts-and-laws/consolidated-acts-2024/` | HTML and PDF | Already scraped; a checkpoint to test against |
| Consolidated acts 2025 | `/consolidated-acts-2025/` | — | **Login wall. Do not bypass.** |
| Acts by year 1956–2026 | `/sri-lanka-acts-<year>/` | Mostly PDF, some HTML (1980 on); **1956–1979 almost all HTML** | **1956–1979 surveyed 2026-10-09 (listing pages only):** 612 files, **593 HTML + 19 PDF** (the PDFs are 1978's, linking parliament.lk `gbills/english/NNNN.pdf`, e.g. Judicature 2/1978). The HTML is born-digital text, not images: Inland Revenue 28/1979 = 858 KB, 60,835 words, 0 `<img>`, one `<table>` row per paragraph with the marginal note in its own cell ("Income chargeable with tax." | "3. For the purposes ..."), the same shape as the 1980–98 lankalaw HTML that `html_pages()` reads; People's Bank 29/1961 the same. Per year: 1956 8, 1957 15, 1958 18, 1959 4, 1960 3, 1961 29, 1962 3, 1963 4, 1964 10, 1965 8, 1966 9, 1967 **0 parsed** (the page has 10 `.html` and 12 `.pdf` links in another row format; `ROW` misses them, not checked), 1968 53, 1969 37, 1970 36, 1971 57, 1972 20, 1973 55, 1974 42, 1975 49, 1976 36, 1977 25, 1978 20, 1979 71. 1972–77 rows include the National State Assembly **Laws** under the same number (5/1972 Agrarian Research and Training Institute, 11/1973 Apartment Ownership, 21/1977 Partition), which amending Acts cite as `law:N/YYYY`. **Terms of use (read 2026-10-09, https://lankalaw.net/terms-and-conditions/):** "Users shall not … scrape or copy content in bulk"; IP clause claims "databases … search structures" for Chat2Find (Pvt) Limited; use is licensed "for lawful internal purposes during an active subscription period". The statute words are not copyrightable (IP Act No. 36 of 2003 s.8: official legislative texts), but **lankalaw's HTML is their own work** (retyped text, note/section table layout), and so is the 1980 Revised Edition copy we hold (OCR text re-typeset as text-only PDF, LAYOUT.md), unlike the Gazette scans they host. Affected in R2 already: 158 lankalaw HTML Acts (1980 on, fetched 2026-10-05) and 516 Revised Edition chapters (2026-10-07); 573 lankalaw PDFs are Gazette scans. **Decision (user, 2026-10-09): fetch the pre-1980 HTML too**; only the law text is used downstream (structured sections, not lankalaw's markup), and statute text is not copyrightable. Provenance stays recorded (`documents.source_url`). Risk noted: the terms are a contract question separate from copyright. 1967's listing rows carry no file links (titles only), so 1967 has no files. Not checked yet: what parliament.lk (`/uploads/acts/gbills/english/`), documents.gov.lk or the Government Printer hold for 1956–1979. These are the targets of most unresolved graph edges (Neon 2026-10-09: 1,420 change edges to 1970s Acts, 584 to Inland Revenue 28/1979 alone; 643 to `law:`). Fetched from 2026-10-09 (`etl.fetch lankalaw` discovers 1956 on; was 1980 on, decision 2026-10-05). | Fills the 1980–98 English gap. Table rows are `NN/YYYY : <a href=…pdf\|html>Title</a>`, so they match our `act_no`. Probed 2026-10-05: **1985: 56 rows, 41 PDF links** (documents.gov.lk has 0 English for 1985); **1991: 30 PDF links** (documents.gov.lk lists only 10 of 53 Acts). Language of the PDFs not checked yet (titles are English). 1956–1979 pages would give pre-1980 Acts by number, which the 1980 Revised Edition files under chapter numbers instead. **Heavy scans (measured 2026-10-06):** 573 PDFs fetched = 9.39 GB, 82% of R2. 1980s sample of 15 each: median 1406 KB/page against 22 KB/page for documents.gov.lk scans of the same decade (same median length, 6 pages), so about 60× per page; largest file 748 MB. Image encoding not inspected (likely greyscale/colour vs 1-bit). If shown to users, serve a compressed copy (e.g. `view/<sha256>.pdf` via ghostscript on ada, which has `gs`), never replace `source/`. **Off-site links (checked 2026-10-06):** 6 of 731 rows failed to fetch. 4 link third-party hosts that are gone: citizenslanka.org (no DNS; 20/1994, 22/1994), agrimin.gov.lk (404; 6/1994), stepbysteptrade.lk (expired TLS cert; 11/1994). All 4 are on the Wayback Machine as PDFs, and `etl/fetch.py` now falls back to `web.archive.org/web/2id_/<url>`. The other 2 (25/1993, 45/1985) link documents.gov.lk `_S.pdf` files, i.e. **Sinhala**, which 404 at those old paths; we already hold the Sinhala from `acts`. Discovery now skips `_S`/`_T` links. Still with no English file: 0/2001 (17th Amendment), 47/1982, 18/1988, 26/1990, 37/1995, which neither site has in English |
| Core legislation | site nav | — | Constitution, Penal Code, CPC, Evidence Ordinance, Judicature Act. The likely source for the **1978 Constitution base text**; not yet checked |

## parliament.lk

robots.txt: everything allowed except `/adminpanel`, `/api` and `/preview`. Sitemap: `/sitemap.xml`.

| Source | Where | Notes |
|---|---|---|
| SC decisions on Bills | `/en/business-of-parliament/sc-decisions-on-bills` → `/uploads/documents/scdecisions/sc-decisions-on-parliamentary-bills-<years>-volume-<n>.pdf` | Volumes IX–XVI (~2007+); XIV is not linked |
| Hansard | `/en/business-of-parliament/hansards?page=N` → `/uploads/businessdocs/english/<id>_english_<date>.pdf` | ~221 listing pages, 1931–2026 |
| Constitution | `/en/constitution-main` | Rendered in JavaScript, so no links show in plain HTML |

## Courts

Both are WordPress. The yearly listing pages contain direct PDF links. Cloudflare challenges `www.` and `robots.txt`, but plain non-www page fetches with a browser-like User-Agent worked.

| Court | Listing | PDFs | Years |
|---|---|---|---|
| Supreme Court | `https://supremecourt.lk/judgements/?case_year=YYYY` | `/wp-content/uploads/judgements/*.pdf` (2024: 301) | 2010– |
| Court of Appeal | `https://courtofappeal.lk/judgements/?case_year=YYYY` | `/wp-content/uploads/judgements/*.pdf` (2024: 551) | 2010– |

`judgements.courtofappeal.lk` (the old archive) is behind a CAPTCHA.

## Dead or blocked

| Source | Status |
|---|---|
| lawnet.gov.lk (Ministry of Justice, official host of the 1980 edition) | Dead: bad TLS certificate, and the body is just "root directory" |
| commonlii.org/lk | **Cloudflare bot challenge** ("Just a moment…", HTTP 403 on every page incl. robots.txt; rechecked 2026-10-09). Do not bypass. Wayback Machine (CDX, 2026-10-09): `/lk/legis/consol_act/` archived 2007 holds **516 Acts as `.txt` + `.pdf`** (codes like `aa229300`, `a104180`), the same count and naming style as lankalaw's 1980 Revised Edition (516 PDFs, `sog93171.pdf`): almost certainly the same LawNet 1980 set, so nothing new. Also `/lk/legis/const/` (5 files) and ~59 loose `.txt`; not opened. **`/lk/legis/num_act/` (numbered Acts, as enacted; live site also behind Cloudflare, checked 2026-10-09) is different and valuable:** Wayback (mostly 2008 snapshots) has **1,816 Acts/Laws with an archived `index.html`**, one directory each, HTML split into `index.html`, `longtitle.html`, `s1.html`, `s2.html` … Directory = title initials + number + `o` + year + id, Act/Law by the last initial: `cocpa15o1979276` = Code of Criminal Procedure Act 15/1979, `tbl19o1978…` = Transport Board Law 19/1978 (beside `dca19o1978…` = Debt Conciliation (Amendment) Act 19/1978). Per decade: 1950s 75, 1960s 205, 1970s 386, 1980s 492, 1990s 434, 2000s 224; 1967: 0. Fills graph gaps act:34/1996 (`gasta`), law:7/1978, law:19/1978, law:16/1978, law:40/1978 (~75 edges); not law:4/1978 (BOI/GCEC), law:15/1978, law:15/1972. Born-digital text for the 1980–98 years we OCR from scans. **Decision (user, 2026-10-09): fetch only what we hold no file for**: 120 numbers (82 Acts, 38 Laws; 1950s 29, 1960s 54, 1970s 26, 1980s 7, 1990s 3, 2000s 1; 2 numbers with several Acts skipped, e.g. act:18/1965). `etl/spiders/commonlii.py` (Wayback `2008id_` URLs; commonlii.org itself never contacted), reader `etl.structure.commonlii_rows()`. **archive.org pacing:** one page at a time with a 1 s pause took ~70 s an Act (a few seconds a page, after a redirect); 8 pages at a time got `Connection refused` for every request within ~5 minutes. Now one page at a time, 3 s pause, back-off 1–15 min, 4 passes; run overnight 2026-10-09 (`~/sllaw/logs/cl_overnight.sh`). **Result (2026-10-10 00:20 UTC): 110 of 120 fetched, extracted and built** (170 back-off waits, all recovered); 10 fail with HTTP 404 on a section page archive.org never saved (act:68/1961, 58/1961, 34/1964, 30/1966, 30/1957, 26/1990, 24/1966, 22/1964, 16/1966, 15/1965): the fetcher needs every page, so these are not stored. |
| lawlanka.com (NLR, SLR law reports) | Subscription only |
| Provincial council statutes | Spread across 9 provincial websites; not surveyed (wp.gov.lk and ep.gov.lk respond) |

## File formats (sampled)

| Files | Content | Path to text |
|---|---|---|
| Before ~2000, both sites, every language | Image scans, no text layer | OCR on ada |
| documents.gov.lk Sinhala, ~2000+ | Text layer in the legacy FM font (`YS% ,xld` = ශ්‍රී ලංකා) | Convert FM to Unicode, no OCR |
| documents.gov.lk English, 2006+ | Text PDF | docling (current pipeline) |
| Court judgment PDFs | Not checked | — |
