# Sri Lanka Legal PDF Layout Analysis — Findings Report

**Date:** 2026-05-16  
**Documents analysed:** 5 PDFs, full page sweeps across all  
**Tools:** docling 2.93.0, pypdfium2 4.30.0, RT-DETR layout model (docling-layout-heron)

---

## Documents Studied

| Doc | Title | Year | Pages | Page size | Source |
|---|---|---|---|---|---|
| doc1 | Agrarian Development Act No. 46 of 2000 | 2000 | 84 | 384×552 pt (small) | documents.gov.lk |
| doc2 | Appropriation Act No. 23 of 2012 | 2012 | 56 | 595×842 pt (A4) | documents.gov.lk |
| doc3 | Intellectual Property Act No. 36 of 2003 | 2003 | 163 | 384×552 pt (small) | documents.gov.lk |
| doc4 | Civil Aviation Act No. 14 of 2010 | 2010 | 99 | 595×842 pt (A4) | documents.gov.lk |
| doc5 | National Audit Act No. 19 of 2018 | 2018 | 47 | 595×842 pt (A4) | documents.gov.lk |

---

## Page Types Found

There are **four distinct page types** across both documents. The pipeline must detect which type a page is before applying any extraction logic.

### Type 1 — Text Act Page (two-column: main + marginal)

The standard layout for legislative text. The page is split into two vertical bands:
- **Main column**: body text — section paragraphs, subsections, list items, tables
- **Marginal column**: short notes — section number, section title (short title), part header, subject label

The two columns are separated by a gap of ~12 pt (empty x band) in both doc1 and doc2. This gap is the stable cross-document signal for column detection.

**Recto vs verso alternation:**
- Recto pages: marginal column on the **right** (higher x values)
- Verso pages: marginal column on the **left** (lower x values)

Absolute x positions differ between docs (different page widths) but the structure is identical:

| | Doc1 (384pt wide) | Doc2 (595pt wide) |
|---|---|---|
| Recto main | x ≈ 39–278 | x ≈ 144–384 |
| Recto margin | x ≈ 290–343 | x ≈ 396–445 |
| Verso main | x ≈ 106–346 | x ≈ 211–451 |
| Verso margin | x ≈ 34–93 | x ≈ 139–199 |
| Column gap | ~12 pt | ~12 pt |

**Detection:** Count cells in left-band vs right-band. The minority band is the marginal column. Alternatively: find the widest x-gap between cell extents — that is the column separator.

**This type covers:** doc1 pp 1–83, doc2 pp 1–6.

---

### Type 2 — Table/Schedule Page (financial grid)

Found in doc2 from page 7 onward. The entire page is a multi-column financial table:

- Columns: Head No., Ministry/Department name, Programme name, Recurrent amount, Capital amount (sometimes more)
- Column headers span multiple rows; numbers are right-aligned
- "Made up as follows :—" appears as a grouping sub-header
- "Appropriation Act, No. 23 of 2012" runs **vertically** up the right margin (rotated text) — this is the running title for this page type
- The bottom-left sometimes contains "Appropriation Act." as a truncated label

**Raw cells are useless here:** each monetary figure, each abbreviation, each column header is a separate bounding box. Hundreds of tiny boxes per page.

**Strategy:** Route these pages through `docling`'s table structure extraction (`do_table_structure=True`, then use `doc.tables`) rather than raw clusters. The layout model flags these regions as "Table".

**Detection signal:** Full-width cell distribution (cells span entire page width in 4+ x-bands), OR docling cluster label "Table" covers >50% of page area, OR absence of the two-column gap pattern.

---

### Type 3 — Cover/First Page

The first page of each act. Contains:
- Act title (centred, large)
- Certification block ("Certified on the Nth day of...")
- Short act description
- May include a small table-like arrangement of chapter/section numbers

**Detection:** Page index = 0, or cell distribution is centred with no marginal column.

---

### Type 4 — Subscription Template (back cover)

Identical boilerplate across both documents. Contains:
- A single multi-line paragraph: "Annual subscription of English Bills and Acts of the Parliament Rs. 885 (Local), Rs. 1,180 (Foreign) payable to the Superintendent, Government Publications Bureau..."
- The address differs between doc1 (Lotus Road, Colombo 01) and doc2 (Kirulapona Mawatha, Polhengoda, Colombo 05) — different print runs
- Very few cells (< 10 total), most of the page is blank

**Detection:** < 10 cells on page, OR page contains "Annual subscription" text.

---

## Element Types Within Text Act Pages

Within Type 1 pages, the following semantic element types have been observed:

### Marginal Column Elements

| Element | Pattern | Notes |
|---|---|---|
| Section number | Bare integer: "1", "47", "103" | Always in marginal column |
| Section short title | Short phrase, Title Case, ≤ 8 words | e.g. "Short title.", "Farmers' Organisation." |
| Part header | "PART I", "PART II" etc. | Centred in marginal or straddles columns |
| Subject label | Descriptive phrase in marginal | e.g. "Powers and functions of Farmers' Organisation District Federation" |
| Running title | "Agrarian Development Act, No. 46 of 2000" | Appears at top of every marginal column |
| Page number | Bare integer aligned to outer edge | Often in top corner of marginal |

### Main Column Elements

| Element | Pattern | Notes |
|---|---|---|
| Section body text | Numbered: "**1.** (1) Every..." | Leading bold number + subclause |
| Subsection | "(1) ...", "(2) ..." | Indented or at left margin with parens |
| List item | "(a) ...", "(b) ..." | Deeper indent |
| Sub-list item | "(i) ...", "(ii) ..." | Even deeper |
| "Provided that" block | Starts with "**Provided** that..." (italic/bold) | Legal proviso, separate paragraph |
| Part title | "PART I — PRELIMINARY" etc. | Centred, ALL CAPS, spans full main column |
| Section header (centred) | Short ALL CAPS or Title Case centred line | e.g. "GENERAL PROVISIONS" |
| Definitions entry | "\"term\" means..." | In definitions/interpretation sections |
| Table (inline) | Grid within body text | Rare in text acts, common in schedule acts |

### Edge Cases Requiring Context

These cannot be classified by pattern alone — position in document sequence matters:

| Element | Why ambiguous | Resolution |
|---|---|---|
| Cover page elements | Title/cert block looks like section header | Detect page index = 0 |
| Post-PART header text | First section in a Part has no preceding section | Sequence: if preceded by Part header, it is section body |
| Definitions section entries | Look like regular text with quotes | Detect section titled "Interpretation" or "Definitions" |
| Running title in marginal | Same position as section numbers | Distinguish by content matching act title |

---

## Docling Model Behaviour

### What the RT-DETR model gets right
- Page headers and footers (nearly always correct)
- Tables (flags table regions, used for Type 2 pages)
- Large section blocks (Text, Section-header labels)
- Picture/figure regions

### What it gets wrong on these documents
- **Merges main column text with marginal note** into one cluster when they appear on the same horizontal band (e.g. "Short Title" section + "1." section number → one bounding box from x=39 to x=326)
- **Misses some marginal notes** that are very short (1–2 words) — threshold=0.3 causes them to drop below confidence
- **Threshold tuning does not help** the merge problem — lowering to 0.1 still produces the merged box; the model genuinely outputs one box. Cell-level splitting is required.

### The correct approach: cluster bbox + cell-level split

1. Take each cluster from `pg.predictions.layout.clusters`
2. Get the cluster's constituent text cells from `cluster.cells`
3. For each cell, compute `center_x = (r_x0 + r_x2) / 2`
4. Find the column gap dynamically: sorted unique x ranges with no cell coverage
5. Assign each cell to main or marginal band
6. If the cluster contains cells from both bands → split into two boxes
7. Relabel the marginal-band portion as `marginal_note`

This correctly separates "Short Title" (marginal, x≈290) from section 1 body (main, x≈39–278).

---

## Key Spatial Insight: Marginal Notes Are Y-Aligned by Construction

The typesetter intentionally places each marginal note at the same vertical position as the section opener it labels. This collapses the spatial join from a "nearest-neighbour with tolerance" problem into a trivial overlap check:

```
for each marginal cluster at [m_top, m_bot]:
    find main_col cluster whose y-range overlaps [m_top, m_bot]
    → that section gets this marginal text as short_title
```

No distance heuristic needed. If a page has no marginal cluster overlapping a section opener, that section has no short title on this page (it is a continuation from the previous page — the short title was already captured at the section start).

## Text Reconstruction (No Custom Assembler Needed)

Docling cluster = one logical paragraph already assembled. Cells within a cluster are in reading order. Text reconstruction is simply:

```python
parts = []
for cell in cluster.cells:
    t = cell.text.strip()
    if parts and parts[-1].endswith('-'):   # hyphenation
        parts[-1] = parts[-1][:-1] + t
    else:
        parts.append(t)
text = ' '.join(parts)
```

No paragraph assembler needed. The only thing we add is the column split (cell-level, at the dynamic gap) and the pattern classifier.

## Final Pipeline Architecture

```
PDF
 │
 ├─ docling → pg.predictions.layout.clusters (per page)
 │
 └─ Per page:
       │
       ├─ Page type detection
       │    < 8 cells           → cover or back-page (skip/metadata)
       │    no column gap       → table/schedule (skip for now)
       │    clear column gap    → text-act page
       │
       └─ Text-act page:
             │
             ├─ find_column_gap(): sorted cell x-extents → largest empty band
             ├─ count cells each side → determine which side is main
             ├─ split each cluster's cells at gap → main_cells / marginal_cells
             ├─ cells_text(cells) → reconstructed paragraph text (hyphenation handled)
             │
             ├─ main elements sorted by y_top → classify each:
             │    ^\d+\.        → section_opener
             │    ^PART [IVX]   → part_header
             │    ^\(\d+\)      → subsection
             │    ^\([a-z]\)    → list_item
             │    ^\([ivx]+\)   → sub_item
             │    ^Provided\b   → proviso
             │    else          → text
             │
             └─ marginal elements → [(text, y_top, y_bot)]
                  y-overlap join → section.short_title

Sequential walk over all pages → Part → Section → body tree → JSON
```

## Output Format (JSON)

```json
{
  "title": "Agrarian Development Act",
  "number": 46,
  "year": 2000,
  "certified": "22nd August, 2000",
  "parts": [
    { "number": "I", "title": "PRELIMINARY", "sections": [1, 2, 3] }
  ],
  "sections": {
    "47": {
      "number": 47,
      "short_title": "Powers of Farmers Organisation District Federation.",
      "part": "IV",
      "body": [
        { "type": "subsection", "number": "1", "text": "Every Farmers' Organisation District Federation may—",
          "items": [
            { "label": "(a)", "text": "acquire, hold, take or give on lease..." },
            { "label": "(b)", "text": "to form Farmers People's Companies;" }
          ]
        },
        { "type": "proviso", "text": "Provided that a person who..." }
      ]
    }
  }
}
```

## Scripts

| File | Purpose |
|---|---|
| `extract_act.py` | Full extractor: PDF → structured JSON |

---

## Page Size Era Split (Confirmed)

The print format changed at some point between 2003 and 2010:

| Era | Page size | Examples |
|---|---|---|
| Pre-~2007 | 384×552 pt (small booklet) | doc1 (2000), doc3 (2003) |
| ~2007 onward | 595×842 pt (A4) | doc4 (2010), doc2 (2012), doc5 (2018) |

The two-column main+marginal layout is **identical in both eras** — only the absolute x positions differ because the page is wider.

## Subscription/Back-Page Template Variants (Confirmed)

The boilerplate final page changed address over time — useful as a version signal:

| Era | Wording | Address |
|---|---|---|
| Pre-~2007 | "Annual subscription... Rs. 885 (Local), Rs. 1,180 (Foreign)..." | Government Publications Bureau, No. 32, Transworks House, Lotus Road, Colombo 01 |
| ~2007–2015 | "Annual subscription... Rs. 885 (Local), Rs. 1,180 (Foreign)..." | Government Publications Bureau, Dept. of Government Information, No. 163, Kirulapona Mawatha, Polhengoda, Colombo 05 |
| ~2016 onward | "English Acts of the Parliament can be purchased at the 'Prakashana Piyasa'..." | Department of Government Printing, No. 118, Dr. Danister De Silva Mawatha, Colombo 8 |

Detection: page has < 10 cells AND contains "Annual subscription" OR "can be purchased" OR "Prakashana Piyasa".

## Cross-Document Layout Confirmation

After sweeping all 5 documents (462 pages total, ~55 pages sampled), the following is confirmed:

1. **The two-column main+marginal layout is universal across all text acts**, regardless of year (2000–2018) or page size.
2. **Appropriation acts are structurally distinct** — their body is a multi-column financial schedule, not a text act. They must be routed to a separate extraction path.
3. **No act has more than two text columns** (no parallel Sinhala/English layout found).
4. **The column gap (~12 pt of empty x space) is present in all text acts** observed.
5. **Definitions/Interpretation sections** (always near the end of an act) use the same two-column layout. The quoted terms ("any person authorized by..." means...) appear as body text; the marginal note for that section is "Interpretation."

## Outstanding Questions

1. **Are Gazette notifications a different format?** Not yet studied — likely different (gazette has multiple items per issue).
2. **What is the exact year of the format transition** from 384×552 to A4? Need to check 2004–2009 acts.
3. **Do any acts contain inline tables within body text?** Not seen yet in text acts — tables seem exclusive to Appropriation/Schedule acts.

---

## Files

| Path | Description |
|---|---|
| `document.pdf` | Doc1: Agrarian Development Act No. 46 of 2000 |
| `document2.pdf` | Doc2: Appropriation Act No. 23 of 2012 |
| `detect_docling.py` | Current detection script (raw cells mode) |
| `detect_layout.py` | Surya CPU detection (sparse, use GPU on ada) |
| `detect_surya_gpu.py` | Surya GPU detection script for ada server |
| `layout_output_docling/` | Output images from docling runs |
| `layout_output_docling/sweep_document_p*.png` | Doc1 full-sweep images (13 pages sampled) |
| `layout_output_docling/sweep_document2_p*.png` | Doc2 full-sweep images (12 pages sampled) |
