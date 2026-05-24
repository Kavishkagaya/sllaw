# ETL — Sri Lanka Legal Document Pipeline

## Pipeline overview

Two independent pipelines share the same migration system and Neon PostgreSQL database.

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
