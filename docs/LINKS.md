# Links: the data model (proposal, 2026-11-09)

Status: **built and published 2026-11-09** (`etl/mentions.py`; v2 links stage, `resolve`, gold check and publish
in `etl/v2/run.py`, `etl/v2/downstream.py`, `etl/v2/schema.sql`). Run by hand on ampere (the same commands the
Dagster ops call): links 7,715 documents with 12 workers in 16 min, `resolve` in seconds, link gold 210/210, quality
gate passed (no change against the 2026-11-08 run), publish replaced 7,298 documents in `kb`. Published: `kb.links`
130,003 rows, all resolved (33,210 same-law, 1,333 same_as); `kb.mentions` 134,142 (22,702 not fully resolved, with
`status` and `unresolved`). `resolve` first used "c.doc_key = x OR c.doc_key IN (twins)" and ran past 6 minutes
on the first insert; as joins over a candidate table it takes seconds. The app filter that keeps a law's own links
out of its "what refers to this law" list is on branch `app/links-skip-self` (not merged).
Two layers in the ETL state DB: `mentions` (what the text says, one row per
citation) and `links` (resolved edges only, one source and one destination per row); `part_links` folds into
`links`. Nothing here changes until it is approved; then one relink writes it.

## Why a new model

Today a link is one flat row: `kind`, `dst_doc`, `dst_label`, a 300-char `context`, `detail` JSON. That loses:

- **Where the citation is.** No offsets: the app cannot underline "section 12 of the Penal Code" in the text.
- **What it does vs how much it touches.** `amends_act` packs both into the kind; "Section 97 of the principal
  enactment is hereby amended" gives an `amends` *and* an `amends_act` row (the whole-law pattern also matches).
- **The exact provision.** `dst_label = "5"` only; "section 5 (2) (a)" loses "(2)(a)", and a Schedule or Part
  label is mixed into the same column.
- **How the target law was found.** By number, by name, as "the principal enactment", as "that Act". Name and
  "that Act" lookups are guesses; a number is not. Nothing tells them apart.
- **Quoted text.** A citation inside text an amending Act inserts ("… under section 5 …") is the amended law's
  text, not the amending Act's own reference.
- **Things we cannot resolve.** A law named but not held, a Provincial Statute, an old Gazette: either dropped or
  a row with no target. The app cannot say "Statute No. 1 of 2010 (not in the library)".
- **Same-law references.** "under section 12" is not linked at all (~27,000 in the corpus, scan 2026-11-09).

## The model

Two layers (decision 2026-11-09, user):

- **`mentions`: what the text says, as read.** One row per citation (one span of text). It may name several
  provisions (`labels`), and it may be unresolved. Nothing the text cites is dropped.
- **`links`: resolved edges only.** One row = one source chunk → one destination (a chunk, or the document when the
  citation is to a whole law). Built from mentions by `resolve`; a mention that does not resolve gives no link, and
  its `status` says why. "Sections 5 to 8 of the X Act are hereby repealed" is one mention and four links; a
  repealed Part is one mention and one link per section under it (today's `part_links`, now ordinary links).

### `mentions` (one per citation)

| column | meaning | example |
|---|---|---|
| `id` | | |
| `src_doc`, `src_chunk` | where it is | `act:11/1998`, chunk uuid |
| `start`, `end` | character offsets in the chunk text (as stored in R2) | 412, 447 |
| `span` | the exact text at those offsets | `section 49 of the said Act` |
| `relation` | what the text does to the target (below) | `cites` |
| `scope` | how much of the target | `provision` |
| `law_form` | how the target law is written | `anaphora` |
| `law_text` | the words that name the law | `the said Act` |
| `dst_type` | `law`, `constitution`, `amendment`, `gazette`, `statute`, `self` | `law` |
| `dst_doc` | the law, when the text gives its number (else filled by `resolve`) | `act:69/1981` |
| `dst_name` | the name as written, when there is no number | `Western Province Sports Statute` |
| `unit` | `section`, `article`, `schedule`, `part`, `chapter`, `paragraph`, `regulation`, `title`; null for whole law | `section` |
| `labels` | every provision named, ranges expanded | `{49}`, `{5,6,7,8}` |
| `sub` | the path under the provision, as written | `(2)(a)` |
| `in_quote` | inside quoted text an amendment inserts or substitutes | false |
| `confidence` | `high` / `medium` / `low`, by rule (below) | `medium` |
| `via` | the refs.py pattern that read it | `cite` |
| `ops` | for change relations: the edits (as `detail.ops` today) | `[{op: substitute, loc: "subsection (1)", old: "…", new: "…"}]` |
| `effective` | when the change takes effect, if the text says ("with effect from …") | 2011-04-01 |
| `status` | set by `resolve` (below) | `resolved` |
| `unresolved` | the labels that gave no link | `{48B}` |
| `refs_version` | hash of refs.py that wrote it | |

A citation naming two laws ("Acts Nos. 5 of 1990 and 6 of 1991") is two mentions, one per law, so `dst_doc` is one
value.

**`relation`** (what the text does):

| relation | text form |
|---|---|
| `amends` | "section 5 … is hereby amended", "In … there shall be substituted …" |
| `inserts` | "the following new section … inserted … as section 5A" |
| `replaces` | "… repealed and the following substituted", "there shall be substituted for section 5" |
| `repeals` | "section 5 … is hereby repealed", "The X Ordinance is hereby repealed" |
| `rescinds` | an Order / Notification "is hereby rescinded / revoked / cancelled" (gazettes) |
| `made_under` | regulations or an order made under a provision ("by virtue of the powers vested in me by section 3 of …") |
| `consolidates` | a Revised Edition chapter listing the laws it consolidates |
| `cites` | any other reference |

**`scope`**: `provision` (a section, Article, paragraph), `part` (a Part or Chapter), `schedule`, `title` (long
title, preamble), `whole_law`. Today's `amends_act` = `amends` + `whole_law`; `repeals_act` = `repeals` + `whole_law`.

**`law_form`** (how the law was written, which is also why we trust it or not):

| law_form | example |
|---|---|
| `number` | "Act, No. 5 of 1990", "Ordinance No. 23 of 1912" |
| `chapter` | "(Chapter 101)", "Cap. 262" |
| `name` | "the Penal Code", "THE INLAND REVENUE ACT" |
| `principal` | "the principal enactment" |
| `defined` | a name the law defines: "(hereinafter referred to as "the Code")", ""the Act" means …" |
| `anaphora` | "the said Act", "the aforesaid Ordinance", "that Act", "the same Code" |
| `this_law` | "section 12 of this Act", and a bare "under section 12" outside quotes |
| `constitution` | "Article 154 of the Constitution" |
| `amendment` | "the Thirteenth Amendment to the Constitution" |
| `gazette` | "Gazette Extraordinary No. 1992/29" |
| `statute` | "Western Province … Statute No. 01 of 2010" |

**`confidence`** (a rule, not a model score):
- `high`: `number`, `chapter`, `principal`, `defined`, `constitution`, `amendment`, `gazette`, `statute`, and
  `this_law` with an explicit "of this Act".
- `medium`: `name` resolved to one held law; `anaphora` with one candidate law of that kind named before it in the
  section; a bare `this_law` section.
- `low`: `anaphora` with several candidates (the last one is taken), a `name` that several laws share (the newest
  before the source is taken), OCR-tolerant forms, and a gazette `relation` read from nearby words.

**`status`** (per mention): `resolved` (every label gave a link), `partial` (some did: the rest are in
`unresolved`), `inserted` (the labels are provisions another link inserts, so there is no original chunk),
`label_not_found` (law held, provision not), `not_held` (law identified, not in the library), `unidentified` (a
name or anaphora that matched no law).

### `links` (resolved edges only)

| column | meaning | example |
|---|---|---|
| `id` | | |
| `mention_id` | the citation it comes from | |
| `src_doc`, `src_chunk` | the source (copied from the mention) | `act:11/1998`, uuid |
| `relation`, `scope` | copied from the mention | `cites`, `provision` |
| `dst_doc` | the document reached (the cited law, or its `same_as` twin) | `act:69/1981` |
| `dst_chunk` | the provision's first chunk; null only for `whole_law` | uuid |
| `dst_label` | the provision | `49` |
| `part` | for a link from a repealed Part, the Part named | `Part IV` |
| `via_alias` | reached through a `same_as` twin (another edition) | false |

Every row has a source and a destination; no nulls there except `dst_chunk` on whole-law links. `same_as` stays its
own table (editions and old laws that are the same law); it is not a mention.

## Rules that come with it

1. **One span, one mention.** Overlapping matches of different patterns over the same words keep the most specific
   (operative over whole-law). This removes the `amends_act` copy of every section amendment; the whole-law
   relation stays only where the text changes the whole law.
2. **Anaphora** ("said / aforesaid / same / that Act|Ordinance|Law|Code|enactment"): the last law of that kind named
   earlier in the same section, else the principal enactment. Today "that Act" always means the principal (wrong
   in "acquired under that Act" after the Land Acquisition Act).
3. **Same-law sections**: "section N of this Act", and a bare "section N" outside quotes → `self`. Inside quoted
   inserted text → the law being amended (`in_quote` true). In Constitution documents a bare "Article N" →
   the Constitution.
4. **Defined names**: "(hereinafter referred to as "X")" and ""X" means the Y Act" add X to the law's names for the
   rest of the document (the principal-enactment rule, generalised).
5. **Nothing the text cites is dropped**: an unresolved name, a Statute or an old Gazette stays a mention with status
   `not_held` / `unidentified` (and gives no link), so the app can show it as text with "(not in the library)".

## In `kb` (what the app reads)

`kb.mentions` and `kb.links` are copies of the two tables. `kb.links` keeps today's columns (`kind` computed as
today: relation, plus `_act` for `whole_law`; `status`, `date`, `context` from the mention), so the app keeps working
unchanged; new columns are added beside them. The app can then underline a mention's span, show "amended by …
(low confidence)", list a law's "(not in the library)" citations from `kb.mentions`, and keep same-law references
(`dst_type = self`) out of "what cites this law".

## Measured (2026-11-09, ampere, in memory, no writes)

`etl/mentions.py` (new; `etl/refs.py` unchanged, because the structure build reads it and its hash is in the build
fingerprint: an edit there rebuilds every document) against `etl.refs.links` over all 7,715 documents (chunk text from
R2, labels and `same_as` from the ETL Neon). Resolution done in memory as `resolve` does it. Tests: `python -m
etl.test_mentions` (new), `python -m etl.test_refs` (unchanged, passes).

| | old (refs.py) | new (mentions.py) |
|---|---|---|
| rows | 105,387 link rows | 134,142 mentions |
| resolved targets (= links) | 89,841 | **127,708** (33,522 same-law) |
| label not found / inserted / not held | 5,046 / 6,208 / 4,292 | 11,478 / 7,864 / 5,039 |
| unidentified (kept as mentions, no link) | dropped | 2,922 |
| gold set (195, same_as excluded) | 186 | 186 (7 through the change link that now carries a duplicate "cites") |

- **Confidence of mentions:** high 73,366, medium 49,406, low 11,370; 11,277 inside quoted inserted text.
- **law_form:** number 32,914; principal 30,622; this_law 28,112; name 18,080; chapter 9,647; anaphora 5,755;
  gazette 4,003; constitution 3,623; amendment 738; defined 491; statute 157.
- **Old links not in the new set:** 14,654 are "cites" rows that duplicated a change link on the same provision (now
  one mention). 1,576 "cites" gone; those read by hand were wrong before: sections of "that Act" sent to the principal
  (act:1/1987 → law:42/1975 instead of the Consumer Protection Act 1/1979 named in the sentence), "Second Schedule
  of the Order" read as the Act's, a 1971 Act's sections sent to the 1978 Constitution, and the whole-law
  "the Constitution" copy beside each Article link. Change links lost: 47 (inserts 13, made_under 30, repeals 5,
  amends 4); read by hand: Part IIA inserted into the principal instead of the Finance Act named (act:15/2011),
  s440B into the amending Act instead of the Criminal Procedure Code (act:31/1962), "section 32 E" read as 32
  (gazette:1690/11): the old links were wrong.
- **Recall (scan phrases overlapping a mention span):** bare sections 96.6% of 31,099; said/aforesaid 94.1%; that
  Act 94.5%; Constitution amendments 100%; Statutes 100%; gazettes 95.1%; numbers 74.8% and names 63.8% (the rest
  read by hand: a law's own title and short-title lines, schedules of HS codes, "the 1988 Convention"; not
  citations); "this Part of this Act" 77.5% (no number to link).
- **Hand check of samples (12 each unless said):** same-law sections 12/12; Constitution Articles in its own
  documents and amendments 12/12; bare sections in amending laws → principal 23/24 (the miss: the amending law's
  own "sections 4 and 5"); Constitution amendments with section 12/12; "of this Act" parts 12/12; "that Act" whole
  9/9; inserts 12/12; low-confidence anaphora ~9/12 before the unknown-law stop (fixed: "that Ordinance" after a law
  we do not hold now gives no link); gazette relation guess ~9/12 (stays `low`). Defined names were noisy in the
  first run ("the law", "the act"): now capitalised only and kept only when the law defines them; not re-sampled.
- **Agent:** the 7 in-force checks of the 2026-10 eval (incoming repeals_act / amends_act) return the same laws, now
  with a confidence. Out-links of the 20 eval gold sections: old 2 sections with any, new 7, all same-law references
  a reader follows (act:12/2026 s357 → s302, s419; act:43/2000 s53 → ss21-23, 26; act:21/2006 s4 → s2; cap1956:101
  s306 → s299). Text-filtered calls ("Article 91") not compared: the replay could not apply the old text filter.
  Not measured: an agent run on the new data (needs a publish).
- **Fixed on the way (also wrong in refs.py):** customs tariff "Chapter 46" in gazettes read as a law's chapter;
  "part is formed" read as a Part; "section 27 A (1)" read as 27.

## Measuring it next

- About 100 new gold links for the new forms (anaphora, same-law, in-quote, defined names, Constitution
  amendments, Statutes) and 20 gazette links, checked against the written tables.
- A recall set: sentences with every reference in them marked by hand; recall = provisions linked / marked.
- An agent eval on the new data after the relink (the 20 questions of 2026-10-18).

## Not in this model (yet)

- Judgments citing laws or other judgments (no judgments in the corpus).
- Whether a target provision is in force on a date (that is the change history read from these links, not a link).
- Sinhala and Tamil text (English only, decision 2026-10-04).
