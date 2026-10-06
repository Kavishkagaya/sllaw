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
| Legislative Enactments 1980 Revised Edition | `/legislative-enactments/ceylon-legislative-enactments-1980/` | One PDF per chapter (`sog93171.pdf` = Sale of Goods, Cap. 93) | Last **official** consolidation; the 1980 baseline. One HTML table lists everything: 519 rows with a PDF, **516 distinct PDFs**, chapter numbers up to 636, so chapters without a PDF exist (surveyed 2026-10-04). Spider: `etl/spiders/le1980.py`; `etl.fetch le1980`. Not fetched yet |
| Legislative Enactments 1956, 1656–1956 | `/ceylon-legislative-enactments-1956/` | One PDF per chapter | Historical |
| Consolidated statutes up to 2006 | `/consolidated-statutes-upto-2006/` | HTML, ~1,490 | Already in `consolidated_statutes`; the 2006 baseline |
| Consolidated acts 2024 | `/legislations/acts-and-laws/consolidated-acts-2024/` | HTML and PDF | Already scraped; a checkpoint to test against |
| Consolidated acts 2025 | `/consolidated-acts-2025/` | — | **Login wall. Do not bypass.** |
| Acts by year 1956–2026 | `/sri-lanka-acts-<year>/` | Mostly PDF, some HTML | Fills the 1980–98 English gap. Table rows are `NN/YYYY : <a href=…pdf\|html>Title</a>`, so they match our `act_no`. Probed 2026-10-05: **1985: 56 rows, 41 PDF links** (documents.gov.lk has 0 English for 1985); **1991: 30 PDF links** (documents.gov.lk lists only 10 of 53 Acts). Language of the PDFs not checked yet (titles are English). 1956–1979 pages would give pre-1980 Acts by number, which the 1980 Revised Edition files under chapter numbers instead |
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
| commonlii.org/lk | 403 |
| lawlanka.com (NLR, SLR law reports) | Subscription only |
| Provincial council statutes | Spread across 9 provincial websites; not surveyed (wp.gov.lk and ep.gov.lk respond) |

## File formats (sampled)

| Files | Content | Path to text |
|---|---|---|
| Before ~2000, both sites, every language | Image scans, no text layer | OCR on ada |
| documents.gov.lk Sinhala, ~2000+ | Text layer in the legacy FM font (`YS% ,xld` = ශ්‍රී ලංකා) | Convert FM to Unicode, no OCR |
| documents.gov.lk English, 2006+ | Text PDF | docling (current pipeline) |
| Court judgment PDFs | Not checked | — |
