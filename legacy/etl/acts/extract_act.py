#!/usr/bin/env python3
"""
extract_act.py — Sri Lanka Legal Act Structured Extractor

Two-pass architecture
---------------------
Pass 1  (needs PDF + docling):
    serialize_clusters(clusters)  convert docling objects → plain dicts
    Spider serialises every page into docling_json and stores it.

Pass 2  (pure JSON, no PDF):
    build_document(docling_json)  build doc_json from serialised clusters
    Can be re-run any number of times without touching the PDF or network.

CLI usage:
    .venv/bin/python3 extract_act.py <pdf>
    .venv/bin/python3 extract_act.py <pdf> <out.json>
    .venv/bin/python3 extract_act.py <json> --section 47
    .venv/bin/python3 extract_act.py <json> --search "Commissioner"
"""

import json
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium
from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.base_models import InputFormat
from docling.datamodel.layout_model_specs import DOCLING_LAYOUT_EGRET_LARGE
from docling.datamodel.pipeline_options import LayoutOptions, PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

# ── Pattern matchers ──────────────────────────────────────────────────────────

RE_SECTION       = re.compile(r'^(\d+)\.\s*(.*)', re.DOTALL)
RE_SECTION_ALPHA = re.compile(r'^(\d+[A-Za-z]+)\.\s*(.*)', re.DOTALL)  # e.g. 1A. 2B.
RE_SUBSECT   = re.compile(r'^\((\d+)\)\s*(.*)', re.DOTALL)
RE_LIST_ITEM = re.compile(r'^\(([a-z])\)\s*(.*)', re.DOTALL)
RE_SUB_ITEM  = re.compile(r'^\(([ivxlcdm]+)\)\s*(.*)', re.DOTALL | re.IGNORECASE)
RE_PART      = re.compile(r'^PART\s+([IVXLC]+)[—\-\s]*(.*)', re.IGNORECASE | re.DOTALL)
RE_CHAPTER   = re.compile(r'^CHAPTER\s+([IVXLC]+)[—\-\s]*(.*)', re.IGNORECASE | re.DOTALL)
RE_DIVISION  = re.compile(r'^Division\s+([IVXLC]+|[0-9]+)\s*[:\-—]\s*(.*)', re.IGNORECASE | re.DOTALL)
RE_PROVISO   = re.compile(r'^Provided\b')
RE_SCHEDULE  = re.compile(
    r'^(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH'
    r'|\d+(?:ST|ND|RD|TH))\s+SCHEDULE\b'
    r'|^SCHEDULE\s+[IVXLC\d]'
    r'|^TABLE\s+[A-Z]\b'
    r'|^FORM\s+[A-Z0-9]',
    re.IGNORECASE,
)
RE_INTEGER   = re.compile(r'^\d+$')
RE_PRINT_REF = re.compile(r'^\d+\s*[—–-]\s*PP\s*\d+')

# Cover / title page — single-column pages whose first line starts with these
# are parliament title pages, not unclassified content.
RE_TITLE_PAGE = re.compile(
    r'^PARLIAMENT\s+OF'
    r'|^DEMOCRATIC\s+SOCIALIST\s+REPUBLIC'
    r'|^Certified\s+on\b',
    re.IGNORECASE,
)

# Structural patterns we don't yet handle — route content to rest
RE_STRUCTURAL_ALARM = re.compile(
    r'^SECTION\s+\d',              # written-out SECTION 5 (all-caps only)
)

# "Article N" structural heading — used in treaty/convention acts instead of sections.
# Distinguishes headings ("Article 5 - Cargo") from inline refs ("Article 65 of the Constitution").
RE_ARTICLE = re.compile(r'^Article\s+(\d+[A-Z]?)\s*[—–\-]?\s*(.*)', re.IGNORECASE | re.DOTALL)
RE_ARTICLE_INLINE = re.compile(r'^of\s+the\b|^of\s+this\b|^,\s|\bConstitution\b', re.IGNORECASE)

# Amendment language — when a section's body or marginal note matches this,
# subsequent section-like openers inside that section are replacement text
# for the amended act, not new top-level sections.
RE_AMENDMENT = re.compile(
    r'\bis\s+hereby\s+amended\b'
    r'|\bis\s+amended\s+by\b'
    r'|\bshall\s+be\s+amended\b'
    r'|\bby\s+substitut(?:ing|ion)\b'
    r'|\bby\s+insert(?:ing|ion)\b'
    r'|\bby\s+delet(?:ing|ion)\b'
    r'|\bby\s+omitting\b'
    r'|\bby\s+adding\b'
    r'|\bby\s+the\s+repeal\b'
    r'|\brepeal\s+of\s+(?:section|subsection)\b'
    r'|\bfollowing\s+(?:section|subsection|paragraph)\s+(?:is|are)\s+(?:substituted|added|inserted)\b'
    r'|\bamendment\s+of\b'
    r'|\breplacement\s+of\s+(?:section|subsection)\b'
    r'|\bsubstitution\s+therefor\b',
    re.IGNORECASE,
)

GAP_MIN_PT     = 8   # minimum column gap width in PDF points
MIN_CELLS_BODY = 8   # pages with fewer cells → cover or back-page


# ── Label-sequence helpers ────────────────────────────────────────────────────

def _roman_val(s: str):
    """Roman numeral string → integer, or None if not a valid roman numeral."""
    vals = {'i': 1, 'v': 5, 'x': 10, 'l': 50, 'c': 100, 'd': 500, 'm': 1000}
    s = s.lower()
    if not s or not all(c in vals for c in s):
        return None
    result, prev = 0, 0
    for ch in reversed(s):
        v = vals[ch]
        result += v if v >= prev else -v
        prev = v
    return result if result > 0 else None


def _is_next_label(prev: str, curr: str) -> bool:
    """True if curr follows prev in the same numbering sequence (alpha or roman)."""
    if prev is None:
        return True
    # Alpha: single lowercase letters a→b→c…
    if len(prev) == 1 and len(curr) == 1 and prev.isalpha() and curr.isalpha():
        if ord(curr) == ord(prev) + 1:
            return True
    # Roman numerals
    pv = _roman_val(prev)
    cv = _roman_val(curr)
    if pv is not None and cv is not None and cv == pv + 1:
        return True
    return False


def _label_type(label: str) -> str:
    """'roman' if label has a valid roman numeral interpretation, else 'alpha'."""
    return 'roman' if _roman_val(label) is not None else 'alpha'


def _score_level(entry: dict, label: str, x0: float, label_type: str) -> int:
    """Score for placing `label` at an existing stack level (higher = better fit)."""
    score = 0
    if entry['type'] == label_type:
        score += 25
    d = abs(x0 - entry['x0'])
    if d < 5:    score += 20
    elif d < 15: score += 10
    elif d < 30: score += 3
    if label_type == 'roman' and entry['type'] == 'roman':
        vn = _roman_val(label)
        # Use the highest roman value ever seen at this level (max_roman_val), not
        # just the most recent one.  Malformed labels (xiviii instead of xlviii)
        # drag 'last' down but the level's max stays correct, so the next valid
        # label (xlix=49) is correctly scored as a small forward step from 44
        # rather than a jump of 32 from the malformed 17.
        vl = entry.get('max_roman_val') or _roman_val(entry['last'])
        if vl and vn:
            gap = vn - vl
            if 0 < gap <= 5:  score += 15   # small forward step
            elif 0 < gap <= 50: score += 8  # forward but larger — likely malformed predecessors
            elif gap < 0:     score -= 5    # regression
    return score


def _score_push(top: dict, label: str, x0: float, label_type: str) -> int:
    """Score for pushing a new sub-level below `top` (higher = stronger push signal)."""
    score = 30  # reasonable baseline — a new sub-level is always plausible
    d = x0 - top['x0']
    if d > 20:   score += 40
    elif d > 10: score += 20
    elif d > 0:  score += 5
    if top['type'] != label_type:
        score += 20
    v = _roman_val(label)
    if label == 'a' or v == 1:
        score += 10   # starting a fresh sequence strongly implies a new level
    return score


# ── Docling setup ─────────────────────────────────────────────────────────────

def build_converter(ocr=False):
    opts = PdfPipelineOptions(
        do_ocr=ocr,
        do_table_structure=True,
        layout_options=LayoutOptions(model_spec=DOCLING_LAYOUT_EGRET_LARGE),
    )
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=opts,
                backend=PyPdfiumDocumentBackend,
            )
        }
    )


# ── Docling-object utilities (Pass 1 helpers) ─────────────────────────────────

def cell_cx(cell):
    return (cell.rect.r_x0 + cell.rect.r_x2) / 2


def cell_x_range(cell):
    return (min(cell.rect.r_x0, cell.rect.r_x1, cell.rect.r_x2, cell.rect.r_x3),
            max(cell.rect.r_x0, cell.rect.r_x1, cell.rect.r_x2, cell.rect.r_x3))


def cell_y_range(cell):
    return (min(cell.rect.r_y0, cell.rect.r_y1, cell.rect.r_y2, cell.rect.r_y3),
            max(cell.rect.r_y0, cell.rect.r_y1, cell.rect.r_y2, cell.rect.r_y3))


def cells_text(cells):
    parts = []
    for cell in cells:
        t = cell.text.strip()
        if not t:
            continue
        if parts and parts[-1].endswith('-'):
            parts[-1] = parts[-1][:-1] + t
        else:
            parts.append(t)
    return ' '.join(parts)


def cluster_label(cluster):
    return cluster.label.value if hasattr(cluster.label, 'value') else str(cluster.label)


def is_header_footer(cluster):
    return cluster_label(cluster) in ('page_header', 'page_footer')


def cells_y_span(cells):
    ys = [y for c in cells for y in cell_y_range(c)]
    return min(ys), max(ys)


# ── Serialize docling clusters → plain dicts (Pass 1 output) ─────────────────

def serialize_clusters(clusters):
    """Convert docling cluster objects to JSON-serialisable dicts.
    Called once per page in Pass 1; result stored in docling_json."""
    result = []
    for cl in clusters:
        cells = []
        for c in cl.cells:
            xs = [c.rect.r_x0, c.rect.r_x1, c.rect.r_x2, c.rect.r_x3]
            ys = [c.rect.r_y0, c.rect.r_y1, c.rect.r_y2, c.rect.r_y3]
            cells.append({
                "text": c.text,
                "x0": min(xs), "y0": min(ys),
                "x1": max(xs), "y1": max(ys),
            })
        result.append({
            "label": cluster_label(cl),
            "bbox": {"t": cl.bbox.t, "b": cl.bbox.b},
            "cells": cells,
        })
    return result


def serialize_table(table_item):
    """Serialize a docling TableItem (from do_table_structure=True) to a plain dict."""
    prov = table_item.prov[0] if table_item.prov else None
    rows = []
    for grid_row in (table_item.data.grid if table_item.data else []):
        row_cells = [cell.text.strip() for cell in grid_row if cell.text.strip()]
        if row_cells:
            rows.append(row_cells)
    return {
        "page_idx": (prov.page_no - 1) if prov else None,
        "bbox_t":   prov.bbox.t if prov else None,
        "rows":     rows,
    }


_RE_FALSE_POS_TABLE = re.compile(r'^\d{1,3}[A-Z]?\.')


def _is_false_positive_table(cells):
    """True if a table cluster is actually section text mislabelled by the layout model."""
    texts = [c["text"].strip() for c in cells if c["text"].strip()]
    return any(_RE_FALSE_POS_TABLE.match(t) for t in texts[:3])


# ── Dict-based utilities (Pass 2) ────────────────────────────────────────────

def dcell_cx(cell):
    return (cell["x0"] + cell["x1"]) / 2


def dcell_x_range(cell):
    return cell["x0"], cell["x1"]


def dcells_text(cells):
    parts = []
    for cell in cells:
        t = cell["text"].strip()
        if not t:
            continue
        if parts and parts[-1].endswith('-'):
            parts[-1] = parts[-1][:-1] + t
        else:
            parts.append(t)
    return ' '.join(parts)


def dis_header_footer(cl):
    return cl["label"] in ('page_header', 'page_footer')


def dcells_to_rows(cells):
    """Group cells into rows by y-overlap, sort each row by x0. Returns list of row lists."""
    if not cells:
        return []
    sorted_cells = sorted(cells, key=lambda c: (c["y0"], c["x0"]))
    rows, cur_row, cur_y1 = [], [sorted_cells[0]], sorted_cells[0]["y1"]
    for cell in sorted_cells[1:]:
        if cell["y0"] < cur_y1:
            cur_row.append(cell)
            cur_y1 = max(cur_y1, cell["y1"])
        else:
            row = [c["text"].strip() for c in sorted(cur_row, key=lambda c: c["x0"]) if c["text"].strip()]
            if row:
                rows.append(row)
            cur_row, cur_y1 = [cell], cell["y1"]
    row = [c["text"].strip() for c in sorted(cur_row, key=lambda c: c["x0"]) if c["text"].strip()]
    if row:
        rows.append(row)
    return rows


# ── Column gap detection ──────────────────────────────────────────────────────

def _gap_from_intervals(intervals):
    if not intervals:
        return None
    intervals.sort()
    merged = [list(intervals[0])]
    for x0, x1 in intervals[1:]:
        if x0 <= merged[-1][1] + 2:
            merged[-1][1] = max(merged[-1][1], x1)
        else:
            merged.append([x0, x1])
    if len(merged) < 2:
        return None
    best, best_gap = None, 0
    for i in range(len(merged) - 1):
        gap = merged[i + 1][0] - merged[i][1]
        if gap > best_gap:
            best_gap = gap
            best = (merged[i][1], merged[i + 1][0])
    if best_gap < GAP_MIN_PT:
        return None
    gl, gr = best
    return (gl + gr) / 2, gl, gr


def find_column_gap(clusters):
    intervals = []
    for cl in clusters:
        for cell in cl.cells:
            x0, x1 = cell_x_range(cell)
            if x1 > x0:
                intervals.append((x0, x1))
    return _gap_from_intervals(intervals)


def find_column_gap_d(clusters_d):
    intervals = []
    for cl in clusters_d:
        for cell in cl["cells"]:
            x0, x1 = dcell_x_range(cell)
            if x1 > x0:
                intervals.append((x0, x1))
    return _gap_from_intervals(intervals)


# ── Page type detection ───────────────────────────────────────────────────────

def detect_page_type(clusters):
    """sparse | title | text | other"""
    all_cells = [c for cl in clusters for c in cl.cells]
    if len(all_cells) < MIN_CELLS_BODY:
        return 'sparse'
    body = [cl for cl in clusters if not is_header_footer(cl)]
    gap  = find_column_gap(body)
    if gap:
        return 'text'
    for cl in body[:5]:
        for c in cl.cells[:2]:
            if RE_TITLE_PAGE.match(c.text.strip()):
                return 'title'
    return 'other'


def detect_page_type_d(clusters_d):
    """sparse | title | text | other"""
    all_cells = [c for cl in clusters_d for c in cl["cells"]]
    if len(all_cells) < MIN_CELLS_BODY:
        return 'sparse'
    body = [cl for cl in clusters_d if not dis_header_footer(cl)]
    gap  = find_column_gap_d(body)
    if gap:
        return 'text'
    for cl in body[:5]:
        for c in cl["cells"][:2]:
            if RE_TITLE_PAGE.match(c.get("text", "").strip()):
                return 'title'
    return 'other'


# ── Page element extraction ───────────────────────────────────────────────────

def page_elements(clusters):
    """Docling-object version: split page into (main_elements, marginal_elements)."""
    body = [cl for cl in clusters if not is_header_footer(cl)]
    gap_result = find_column_gap(body)
    if not gap_result:
        elems = []
        for cl in sorted(body, key=lambda c: c.bbox.t):
            t = cells_text(cl.cells)
            if t:
                xs = [x for c in cl.cells for x in cell_x_range(c)]
                elems.append({'text': t, 'y_top': cl.bbox.t, 'y_bot': cl.bbox.b,
                               'label': cluster_label(cl),
                               'x0': min(xs), 'x1': max(xs)})
        return elems, []

    gap_center, _, _ = gap_result
    left_n  = sum(1 for cl in body for c in cl.cells if cell_cx(c) < gap_center)
    right_n = sum(1 for cl in body for c in cl.cells if cell_cx(c) >= gap_center)
    main_is_left = left_n >= right_n

    main_elems, marg_elems = [], []
    for cl in sorted(body, key=lambda c: c.bbox.t):
        left_cells  = [c for c in cl.cells if cell_cx(c) < gap_center]
        right_cells = [c for c in cl.cells if cell_cx(c) >= gap_center]
        main_cells = left_cells  if main_is_left else right_cells
        marg_cells = right_cells if main_is_left else left_cells
        lbl = cluster_label(cl)
        if main_cells:
            t = cells_text(main_cells)
            if t:
                y0, y1 = cells_y_span(main_cells)
                xs = [x for c in main_cells for x in cell_x_range(c)]
                main_elems.append({'text': t, 'y_top': y0, 'y_bot': y1, 'label': lbl,
                                   'x0': min(xs), 'x1': max(xs)})
        if marg_cells:
            t = cells_text(marg_cells)
            if t and not RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                y0, y1 = cells_y_span(marg_cells)
                marg_elems.append({'text': t, 'y_top': y0, 'y_bot': y1})
    return main_elems, marg_elems


def _make_table_elem(cells, y_top, y_bot, rows=None):
    xs = [x for c in cells for x in (c["x0"], c["x1"])]
    if rows is None:
        rows = dcells_to_rows(cells)
    return {'type': 'table', 'rows': rows,
            'y_top': y_top, 'y_bot': y_bot, 'label': 'table',
            'text': '', 'x0': min(xs), 'x1': max(xs)}


def _resolve_table_rows(cells, bbox_t, table_lookup):
    """Get structured rows: use docling table structure if available, else coordinate grouping."""
    if table_lookup:
        # Find closest stored table by bbox_t within 5 pt tolerance
        best, best_dist = None, 5.0
        for stored_t, stored_rows in table_lookup.items():
            d = abs(stored_t - bbox_t)
            if d < best_dist:
                best, best_dist = stored_rows, d
        if best is not None:
            return best
    return dcells_to_rows(cells)


def page_elements_d(clusters_d, table_lookup=None):
    """Dict version: split page into (main_elements, marginal_elements).
    table_lookup: {bbox_t: rows} from docling table structure for this page."""
    body = [cl for cl in clusters_d if not dis_header_footer(cl)]
    gap_result = find_column_gap_d(body)
    if not gap_result:
        elems = []
        for cl in sorted(body, key=lambda c: c["bbox"]["t"]):
            lbl = cl["label"]
            if lbl == 'table':
                if _is_false_positive_table(cl["cells"]):
                    t = dcells_text(cl["cells"])
                    if t:
                        xs = [x for c in cl["cells"] for x in (c["x0"], c["x1"])]
                        elems.append({'text': t, 'y_top': cl["bbox"]["t"], 'y_bot': cl["bbox"]["b"],
                                       'label': 'text', 'x0': min(xs), 'x1': max(xs)})
                else:
                    rows = _resolve_table_rows(cl["cells"], cl["bbox"]["t"], table_lookup)
                    if rows:
                        elems.append(_make_table_elem(cl["cells"], cl["bbox"]["t"], cl["bbox"]["b"], rows))
            else:
                t = dcells_text(cl["cells"])
                if t:
                    xs = [x for c in cl["cells"] for x in (c["x0"], c["x1"])]
                    elems.append({'text': t, 'y_top': cl["bbox"]["t"], 'y_bot': cl["bbox"]["b"],
                                   'label': lbl, 'x0': min(xs), 'x1': max(xs)})
        return elems, []

    gap_center, _, _ = gap_result
    left_n  = sum(1 for cl in body for c in cl["cells"] if dcell_cx(c) < gap_center)
    right_n = sum(1 for cl in body for c in cl["cells"] if dcell_cx(c) >= gap_center)
    main_is_left = left_n >= right_n

    main_elems, marg_elems = [], []
    for cl in sorted(body, key=lambda c: c["bbox"]["t"]):
        left_cells  = [c for c in cl["cells"] if dcell_cx(c) < gap_center]
        right_cells = [c for c in cl["cells"] if dcell_cx(c) >= gap_center]
        main_cells = left_cells  if main_is_left else right_cells
        marg_cells = right_cells if main_is_left else left_cells
        lbl = cl["label"]
        if main_cells:
            if lbl == 'table':
                if _is_false_positive_table(main_cells):
                    t = dcells_text(main_cells)
                    if t:
                        ys = [y for c in main_cells for y in (c["y0"], c["y1"])]
                        xs = [x for c in main_cells for x in (c["x0"], c["x1"])]
                        main_elems.append({'text': t, 'y_top': min(ys), 'y_bot': max(ys),
                                           'label': 'text', 'x0': min(xs), 'x1': max(xs)})
                else:
                    rows = _resolve_table_rows(main_cells, cl["bbox"]["t"], table_lookup)
                    if rows:
                        ys = [y for c in main_cells for y in (c["y0"], c["y1"])]
                        main_elems.append(_make_table_elem(main_cells, min(ys), max(ys), rows))
            else:
                t = dcells_text(main_cells)
                if t:
                    ys = [y for c in main_cells for y in (c["y0"], c["y1"])]
                    xs = [x for c in main_cells for x in (c["x0"], c["x1"])]
                    main_elems.append({'text': t, 'y_top': min(ys), 'y_bot': max(ys), 'label': lbl,
                                   'x0': min(xs), 'x1': max(xs)})
        if marg_cells:
            t = dcells_text(marg_cells)
            if t and not RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                ys = [y for c in marg_cells for y in (c["y0"], c["y1"])]
                marg_elems.append({'text': t, 'y_top': min(ys), 'y_bot': max(ys)})
    return main_elems, marg_elems


# ── Pattern classification ────────────────────────────────────────────────────

def classify(text):
    """
    Returns (kind, number, remaining_text).
    kind ∈ section_opener | part_header | chapter_header | division_header |
            subsection | list_item | sub_item | proviso | schedule_header | text
    """
    t = text.strip()

    if RE_SCHEDULE.match(t):
        return 'schedule_header', None, t

    m = RE_SECTION.match(t)
    if m:
        return 'section_opener', m.group(1), m.group(2).strip()

    m = RE_SECTION_ALPHA.match(t)
    if m:
        return 'section_opener', m.group(1), m.group(2).strip()  # num is e.g. '1A'

    m = RE_PART.match(t)
    if m:
        return 'part_header', m.group(1).upper(), m.group(2).strip()

    m = RE_CHAPTER.match(t)
    if m:
        return 'chapter_header', m.group(1).upper(), m.group(2).strip()

    m = RE_DIVISION.match(t)
    if m:
        return 'division_header', m.group(1).upper(), m.group(2).strip()

    if RE_PROVISO.match(t):
        return 'proviso', None, t

    m = RE_SUBSECT.match(t)
    if m:
        return 'subsection', m.group(1), m.group(2).strip()

    m = RE_LIST_ITEM.match(t)
    if m:
        return 'list_item', m.group(1), m.group(2).strip()

    m = RE_SUB_ITEM.match(t)
    if m:
        # Normalize capital I → l before lowercasing: serif fonts make I and l
        # visually identical, so PDFs sometimes contain I where l was intended
        # (e.g. xIv instead of xlv).
        label = m.group(1).replace('I', 'l').lower()
        return 'sub_item', label, m.group(2).strip()

    if RE_STRUCTURAL_ALARM.match(t):
        return 'unknown', None, t

    m = RE_ARTICLE.match(t)
    if m:
        num, rest = m.group(1), m.group(2).strip()
        # Inline references ("Article 65 of the Constitution") stay as text.
        if RE_ARTICLE_INLINE.match(rest):
            return 'text', None, t
        return 'article_opener', num, rest

    return 'text', None, t


def marginal_at(marg_elems, y_top, y_bot):
    """Collect marginal texts overlapping [y_top, y_bot] and join them."""
    hits = [m for m in marg_elems if m['y_top'] <= y_bot and m['y_bot'] >= y_top]
    if not hits:
        return None
    hits.sort(key=lambda m: m['y_top'])
    parts = []
    for m in hits:
        t = m['text'].strip()
        if parts and parts[-1].endswith('-'):
            parts[-1] = parts[-1][:-1] + t
        else:
            parts.append(t)
    return ' '.join(parts)


# ── Centered-heading detection ────────────────────────────────────────────────

def _body_center(elems):
    """
    Infer the body column center and full-width from a page's main elements.

    Returns (body_cx, body_max_w).  Elements whose width is >= 70 % of the
    widest element share the same center — that center is the body reference.
    """
    if not elems:
        return None, 0
    ws = [e.get('x1', 0) - e.get('x0', 0) for e in elems]
    max_w = max(ws) if ws else 0
    if max_w < 30:
        return None, 0
    wide = [e for e, w in zip(elems, ws) if w >= max_w * 0.70]
    cxs  = [(e.get('x0', 0) + e.get('x1', 0)) / 2 for e in wide]
    return sum(cxs) / len(cxs), max_w


def _is_subdivision_heading(elem, body_cx, body_max_w, tol=20):
    """
    True when elem is an ALL-CAPS line centered within the body column but
    significantly narrower than full-width body text — i.e. a thematic
    sub-heading between sections, not regular prose.
    """
    if body_cx is None or body_max_w == 0:
        return False
    x0, x1 = elem.get('x0', 0), elem.get('x1', 0)
    if x0 == x1 == 0:
        return False
    elem_cx = (x0 + x1) / 2
    elem_w  = x1 - x0
    return (abs(elem_cx - body_cx) <= tol
            and elem_w < body_max_w * 0.85
            and elem_w > 20
            and elem['text'].strip().isupper())


# ── Hierarchy builder ─────────────────────────────────────────────────────────

def build_structure(pages_data):
    """
    Walk (main_elems, marg_elems, page_type) for each page.
    page_type: 'text' | 'other' | 'sparse' | 'title'

    sections is a dict:
      - normal key  : str(section_number)   e.g. "47"
      - collision   : "PART/number"         e.g. "XXIII/1"  (flagged)

    All body pages — whether two-column ('text') or single-column ('other') —
    run through the same structural classifier.  'other' pages have no marginal
    notes so short_title is None for sections starting on those pages.  Section
    state persists across page-type boundaries.

    Only genuinely unknown structural markers (ARTICLE N, DIVISION N …)
    produce rest entries.

    Returns (parts, sections_dict, schedules, rest, flags).
      rest  : [{"reason": str, "content": [str]}]
              reason: "unknown_structural:ARTICLE 5..."
      flags : informative strings:
                "rest:unknown_structural:ARTICLE 5..."   (one per hit)
                "section_collision:s1_parts_None,V"
    """
    parts               = []
    sections            = {}
    articles            = {}   # treaty/convention acts use Article N instead of Section N
    schedules           = []
    rest                = []
    _unk_buf            = []
    _unk_reason         = None
    _collecting_unk     = False
    _sched_buf          = None
    flags               = []
    current_part        = None
    current_chapter     = None   # chapter within a part (PART → CHAPTER hierarchy)
    current_subdivision = None   # division/centered-heading within chapter or part
    current_section           = None
    current_article           = None   # for treaty acts that use Article N structure
    current_amendment_section = None   # nested amendment content inside current_section
    _in_amendment_context     = False  # current section is amending another act's text
    _awaiting_title_obj = None   # dict whose 'title' needs to be set from next line
    in_schedule      = False
    _seen_sec_nums   = {}
    _max_sec_num     = 0

    # Label-level stack — each entry: {'x0': float, 'last': str, 'node': dict|None}
    # 'node' is the most-recently-created item at that depth; its 'items' list is
    # the parent container for the next deeper level.
    _label_stack = []

    def _reset_labels():
        nonlocal _label_stack
        _label_stack.clear()

    def _resolve_label_depth(label: str, x0: float) -> int:
        """
        Determine nesting depth of a labeled item and update _label_stack.

        1. Sequence continuation — highest priority.  Search stack top-down for a
           level where `label` is the direct next item.  Rolling x0 update on hit
           prevents drift from making old positions stale.

        2. Scoring — when no continuation matches, score each existing level via
           _score_level() (type match + x0 proximity + roman-gap bonus) and compare
           against _score_push() (x0 indent + type-change + fresh-sequence signals).
           The winner decides: snap to an existing level or push a new sub-level.
        """
        nonlocal _label_stack

        new_type = _label_type(label)

        def _update_entry(entry, lbl, new_x0):
            """Write label + x0 into a stack entry, keeping max_roman_val current."""
            entry['last'] = lbl
            entry['x0']   = new_x0
            v = _roman_val(lbl)
            if v is not None:
                prev = entry.get('max_roman_val')
                entry['max_roman_val'] = max(prev, v) if prev is not None else v

        if not _label_stack:
            entry = {'x0': x0, 'last': label, 'type': new_type, 'node': None}
            v = _roman_val(label)
            if v is not None:
                entry['max_roman_val'] = v
            _label_stack.append(entry)
            return 0

        # 1. Sequence continuation with rolling x0 + max_roman_val update.
        for i in range(len(_label_stack) - 1, -1, -1):
            if _is_next_label(_label_stack[i]['last'], label):
                del _label_stack[i + 1:]
                _update_entry(_label_stack[i], label, x0)
                return i

        # 2. Score each existing level vs pushing a new sub-level.
        best_i, best_score = -1, -1
        for i in range(len(_label_stack) - 1, -1, -1):
            s = _score_level(_label_stack[i], label, x0, new_type)
            if s > best_score:
                best_score, best_i = s, i

        push_score = _score_push(_label_stack[-1], label, x0, new_type)

        if best_score > push_score:
            # Snap to existing level: discard deeper entries, update entry.
            del _label_stack[best_i + 1:]
            _update_entry(_label_stack[best_i], label, x0)
            return best_i

        # Push a new sub-level.
        entry = {'x0': x0, 'last': label, 'type': new_type, 'node': None}
        v = _roman_val(label)
        if v is not None:
            entry['max_roman_val'] = v
        _label_stack.append(entry)
        return len(_label_stack) - 1

    def flush_unk():
        nonlocal _unk_reason, _collecting_unk
        if _unk_buf:
            rest.append({"reason": _unk_reason or "unknown_structural",
                         "content": list(_unk_buf)})
            _unk_buf.clear()
        _unk_reason    = None
        _collecting_unk = False

    def flush_schedule():
        nonlocal _sched_buf
        if _sched_buf is not None:
            schedules.append(_sched_buf)
            _sched_buf = None

    def open_section(number, short_title, part_number):
        return {'number': number, 'short_title': short_title, 'part': part_number, 'body': []}

    def flush_amendment():
        nonlocal current_amendment_section
        if current_amendment_section is None:
            return
        if current_section is not None:
            current_section['body'].append({
                'type':        'amendment_section',
                'number':      current_amendment_section['number'],
                'short_title': current_amendment_section.get('short_title'),
                'body':        current_amendment_section['body'],
            })
        current_amendment_section = None
        _reset_labels()

    def flush_article():
        nonlocal current_article
        if current_article is None:
            return
        articles[str(current_article['number'])] = current_article
        current_article = None
        _reset_labels()

    def flush():
        nonlocal current_section, _max_sec_num, _in_amendment_context
        flush_amendment()
        flush_article()
        _reset_labels()
        _in_amendment_context = False
        if not current_section:
            return
        num  = current_section['number']
        part = current_section.get('part', '?')
        key  = str(num)

        if key in sections:
            flags.append(f"section_collision:s{num}_parts_{_seen_sec_nums.get(num, '?')},{part}")
            composite = f"{part}/{num}" if part else f"?/{num}"
            sections[composite] = current_section
        else:
            _seen_sec_nums[num] = part
            sections[key] = current_section

        try:
            num_int = int(num)
            if _max_sec_num > 10 and num_int < _max_sec_num * 0.1:
                flags.append(f"section_regression:{_max_sec_num}_to_{num_int}")
            _max_sec_num = max(_max_sec_num, num_int)
        except (ValueError, TypeError):
            pass
        current_section = None

    def add_to_body(node):
        if current_amendment_section is not None:
            current_amendment_section['body'].append(node)
        elif current_section is not None:
            current_section['body'].append(node)
        elif current_article is not None:
            current_article['body'].append(node)

    def last_body_node(of_type=None):
        body = None
        if current_amendment_section is not None:
            body = current_amendment_section['body']
        elif current_section is not None:
            body = current_section['body']
        elif current_article is not None:
            body = current_article['body']
        if not body:
            return None
        for node in reversed(body):
            if of_type is None or node['type'] == of_type:
                return node
        return None

    # True once structural content (section/part/chapter) is found on a 'text'
    # page.  'other' pages before that point are preliminary (TOC, indices)
    # and should not be parsed as body content.
    body_started = False

    for entry in pages_data:
        main_elems, marg_elems, page_type = entry if len(entry) == 3 else (*entry, 'text')

        if page_type in ('sparse', 'title'):
            continue

        if page_type == 'other' and not body_started:
            continue

        # Both 'text' and 'other' pages go through the same classifier.
        # 'other' pages have marg_elems=[] so marginal_at() returns None.
        body_cx, body_max_w = _body_center(main_elems)

        for elem in main_elems:
            if elem.get('type') == 'table':
                if current_section is not None:
                    add_to_body({'type': 'table', 'rows': elem['rows']})
                elif in_schedule and _sched_buf is not None:
                    for row in elem['rows']:
                        _sched_buf['content'].append(' | '.join(row))
                continue

            if RE_PRINT_REF.match(elem['text'].strip()):
                continue

            # Strip leading quote character so classify() can parse items like
            # '”(7) Whenever...”' or '”(b) ...”' that appear as quoted replacement text
            # in amendment sections. Only applies when inside amendment context.
            _classify_text = elem['text']
            if current_amendment_section is not None or _in_amendment_context:
                _classify_text = _classify_text.strip().lstrip('”').lstrip('”').lstrip()
            kind, num, rest_text = classify(_classify_text)

            # ── Unknown-structural rest-collection mode ───────────────────────
            if _collecting_unk:
                if kind in ('section_opener', 'part_header', 'chapter_header', 'division_header', 'article_opener'):
                    flush_unk()
                    # fall through to normal dispatch below
                else:
                    t = elem['text'].strip()
                    if t:
                        _unk_buf.append(t)
                    continue

            # ── Normal dispatch ───────────────────────────────────────────────

            if not body_started and page_type == 'text' and kind in (
                'section_opener', 'part_header', 'chapter_header', 'division_header',
                'article_opener',
            ):
                body_started = True

            if kind == 'schedule_header':
                flush()
                flush_unk()
                flush_schedule()
                _sched_buf = {"name": elem['text'].strip(), "content": []}
                in_schedule = True
                continue

            if in_schedule:
                t = elem['text'].strip()
                if t and _sched_buf is not None:
                    _sched_buf["content"].append(t)
                continue

            if kind == 'unknown':
                # All-caps "SECTION N" — preserve content under current section as text,
                # flag for inspection but don't route to rest (content would be lost).
                _sec_word_m = re.match(r'^SECTION\s+(\d+)', elem['text'].strip())
                if _sec_word_m and (current_section is not None or current_article is not None):
                    add_to_body({'type': 'text', 'text': elem['text'].strip()})
                    flags.append(f"unstructured:SECTION_{_sec_word_m.group(1)}")
                    continue

                flags.append(f"rest:unknown_structural:{elem['text'].strip()[:60]}")
                flush()
                flush_schedule()
                _collecting_unk = True
                _unk_reason     = f"unknown_structural:{elem['text'].strip()[:60]}"
                _unk_buf.append(elem['text'].strip())
                continue

            if _awaiting_title_obj is not None and kind == 'text' and elem['text'].strip().isupper():
                _awaiting_title_obj['title'] = elem['text'].strip()
                _awaiting_title_obj = None
                continue

            # Centered ALL-CAPS heading between sections → subdivision marker.
            # Flush the current section first so it doesn't absorb the heading.
            # Skip when in amendment context — quoted replacement text (e.g. "GROUP B")
            # is all-caps but is body content, not a structural heading.
            if kind == 'text' and not _in_amendment_context and _is_subdivision_heading(elem, body_cx, body_max_w):
                flush()
                flush_unk()
                t = elem['text'].strip()
                container = current_chapter if current_chapter is not None else current_part
                if container is not None:
                    current_subdivision = {'title': t, 'sections': []}
                    container.setdefault('subdivisions', []).append(current_subdivision)
                continue

            if kind not in ('part_header', 'chapter_header'):
                _awaiting_title_obj = None

            if kind == 'part_header':
                flush()
                current_chapter     = None
                current_subdivision = None
                current_part = {'number': num, 'title': rest_text, 'sections': []}
                parts.append(current_part)
                if not rest_text:
                    _awaiting_title_obj = current_part

            elif kind == 'chapter_header':
                all_chapters = all(p.get('type') == 'chapter' for p in parts)
                if current_part is None or (parts and all_chapters):
                    # No PART context, or document uses chapters as top-level groups
                    flush()
                    current_chapter     = None
                    current_subdivision = None
                    current_part = {'number': num, 'title': rest_text, 'sections': [], 'type': 'chapter'}
                    parts.append(current_part)
                    if not rest_text:
                        _awaiting_title_obj = current_part
                else:
                    # CHAPTER is a sub-grouping within a PART
                    flush()
                    current_subdivision = None
                    current_chapter = {'number': num, 'title': rest_text, 'sections': []}
                    current_part.setdefault('chapters', []).append(current_chapter)
                    if not rest_text:
                        _awaiting_title_obj = current_chapter

            elif kind == 'division_header':
                flush()
                flush_unk()
                title = f"Division {num}" + (f": {rest_text}" if rest_text else "")
                current_subdivision = {'number': num, 'title': title, 'sections': []}
                container = current_chapter if current_chapter is not None else current_part
                if container is not None:
                    container.setdefault('subdivisions', []).append(current_subdivision)

            elif kind == 'section_opener':
                _cur_num = str(current_section['number']) if current_section else None
                try:
                    _n_int = int(num)
                    _is_collision  = str(num) in sections or _cur_num == str(num)
                    _is_regression = _max_sec_num > 10 and _n_int < _max_sec_num * 0.5
                    _is_jump       = _n_int > _max_sec_num + 30
                except (ValueError, TypeError):
                    _n_int         = None
                    _is_collision  = str(num) in sections or _cur_num == str(num)
                    _is_regression = False
                    _is_jump       = False

                # Layout signal: is this element indented relative to the main body?
                # Amendment replacement text sits narrower / further right than body.
                _body_left  = body_cx - body_max_w / 2 if body_max_w else 0
                _is_indented = elem.get('x0', _body_left) > _body_left + 20

                # Open a nested amendment_section when:
                #   • the current section is in amendment context (from text/marginal), AND
                #   • the element is indented OR the section number jumps significantly.
                # Sequential non-indented openers exit amendment context (new real section).
                if _in_amendment_context and current_section is not None:
                    if _is_indented or _is_jump:
                        flush_amendment()
                        try:
                            amend_num = int(num)
                        except (ValueError, TypeError):
                            amend_num = num
                        amend_short = marginal_at(marg_elems, elem['y_top'], elem['y_bot'])
                        current_amendment_section = {
                            'number':      amend_num,
                            'short_title': amend_short,
                            'body':        [],
                        }
                        if rest_text:
                            current_amendment_section['body'].append(
                                {'type': 'text', 'text': rest_text}
                            )
                        continue
                    else:
                        # Sequential non-indented → real next section; exit amendment mode.
                        _in_amendment_context = False

                # Reject duplicates, regressions, and unlabelled large jumps.
                if _is_collision or _is_regression:
                    add_to_body({'type': 'text', 'text': elem['text'].strip()})
                    continue
                if _is_jump:
                    # Large upward jump with no amendment context → schedule/table row.
                    add_to_body({'type': 'text', 'text': elem['text'].strip()})
                    continue

                flush()
                short = marginal_at(marg_elems, elem['y_top'], elem['y_bot'])
                try:
                    sec_num = int(num)
                except (ValueError, TypeError):
                    sec_num = num  # alphanumeric e.g. '1A'
                current_section = open_section(
                    sec_num, short,
                    current_part['number'] if current_part else None,
                )
                # Marginal note "Amendment of section N" immediately signals context.
                if short and RE_AMENDMENT.search(short):
                    _in_amendment_context = True
                if current_part:
                    current_part['sections'].append(sec_num)
                if current_chapter is not None:
                    current_chapter['sections'].append(sec_num)
                if current_subdivision is not None:
                    current_subdivision['sections'].append(sec_num)

                if rest_text:
                    k2, n2, r2 = classify(rest_text)
                    if k2 == 'subsection':
                        add_to_body({'type': 'subsection', 'number': n2, 'text': r2, 'items': []})
                    elif k2 in ('list_item', 'sub_item'):
                        # Route through the label stack so the node reference is
                        # recorded and subsequent nested items attach correctly.
                        depth2   = _resolve_label_depth(n2, elem.get('x0', 0))
                        new_node = {'label': f'({n2})', 'text': r2, 'items': []}
                        if depth2 == 0:
                            add_to_body({'type': 'list_item', **new_node})
                        else:
                            pn = _label_stack[depth2 - 1]['node']
                            (pn['items'] if pn else current_section['body']).append(new_node)
                        _label_stack[depth2]['node'] = new_node
                    elif k2 == 'proviso':
                        add_to_body({'type': 'proviso', 'text': r2})
                    else:
                        add_to_body({'type': 'text', 'text': rest_text})
                    # Amendment language in the inline rest_text sets context immediately.
                    if not _in_amendment_context and RE_AMENDMENT.search(rest_text):
                        _in_amendment_context = True

            elif kind == 'subsection':
                _reset_labels()
                add_to_body({'type': 'subsection', 'number': num, 'text': rest_text, 'items': []})

            elif kind in ('list_item', 'sub_item'):
                depth    = _resolve_label_depth(num, elem.get('x0', 0))
                new_node = {'label': f'({num})', 'text': rest_text, 'items': []}

                if depth == 0:
                    # Top-level: attach to the nearest subsection or directly to body.
                    parent_ss = last_body_node('subsection')
                    if parent_ss is not None:
                        parent_ss['items'].append(new_node)
                    else:
                        add_to_body({'type': 'list_item', **new_node})
                else:
                    # Nested: parent node is the most-recent item at depth-1.
                    parent_node = _label_stack[depth - 1]['node']
                    if parent_node is not None:
                        parent_node['items'].append(new_node)
                    else:
                        # Fallback: no parent node recorded (edge case).
                        add_to_body({'type': 'list_item', **new_node})

                _label_stack[depth]['node'] = new_node

            elif kind == 'proviso':
                add_to_body({'type': 'proviso', 'text': rest_text})

            elif kind == 'article_opener':
                flush()
                flush_unk()
                try:
                    art_num = int(num)
                except (ValueError, TypeError):
                    art_num = num
                short = marginal_at(marg_elems, elem['y_top'], elem['y_bot'])
                current_article = {
                    'number':      art_num,
                    'short_title': short or rest_text or None,
                    'body':        [],
                }
                if rest_text and rest_text != current_article['short_title']:
                    current_article['body'].append({'type': 'text', 'text': rest_text})

            else:
                add_to_body({'type': 'text', 'text': rest_text})
                # Detect amendment language in body text — subsequent section-like
                # openers in this section are replacement content for another act.
                if (not _in_amendment_context
                        and current_section is not None
                        and RE_AMENDMENT.search(rest_text)):
                    _in_amendment_context = True

    flush()
    flush_article()
    flush_unk()
    flush_schedule()

    return parts, sections, articles, schedules, rest, flags


# ── Cover metadata ────────────────────────────────────────────────────────────

_TITLE_NOISE = re.compile(
    r'www\.|downloaded|Gazette|Published|Supplement|Printed|purchased|'
    r'Parliament of the|PARLIAMENT OF', re.IGNORECASE
)


def _cover_meta_from_text(all_text, cluster_texts):
    meta = {}
    m = re.search(r'No\.\s*(\d+)\s+OF\s+(\d{4})', all_text, re.IGNORECASE)
    if m:
        meta['number'] = int(m.group(1))
        meta['year']   = int(m.group(2))
    m = re.search(r'Certified\s+on\s+(.+?)[\.\]<]', all_text, re.IGNORECASE)
    if m:
        meta['certified'] = m.group(1).strip()
    candidates = [
        t for t in cluster_texts
        if re.search(r'\bACT\b', t, re.IGNORECASE)
        and not _TITLE_NOISE.search(t)
        and 5 < len(t) < 120
    ]
    if candidates:
        title = min(candidates, key=len)
        title = re.sub(r'\s*,?\s*No\.\s*\d+.*', '', title, flags=re.IGNORECASE).strip()
        meta['title'] = re.sub(r'\s+', ' ', title)
    return meta


def extract_cover_metadata(clusters):
    texts = [cells_text(cl.cells).strip() for cl in clusters]
    return _cover_meta_from_text(' '.join(texts), texts)


def extract_cover_metadata_d(clusters_d):
    texts = [dcells_text(cl["cells"]).strip() for cl in clusters_d]
    return _cover_meta_from_text(' '.join(texts), texts)


def extract_title_page_d(clusters_d):
    """
    Build a structured title_page object from a cover page's clusters.

    Returns:
      {
        "parliament": str | None,   "PARLIAMENT OF THE DEMOCRATIC SOCIALIST..."
        "title":      str | None,   "COMPANIES ACT"
        "number":     int | None,   7
        "year":       int | None,   2007
        "certified":  str | None,   "31st March 2007"
        "lines":      [str],        all non-empty text lines on the page
      }
    """
    lines    = [dcells_text(cl["cells"]).strip() for cl in clusters_d]
    lines    = [l for l in lines if l]
    all_text = ' '.join(lines)

    page = {"parliament": None, "title": None, "number": None,
            "year": None, "certified": None, "lines": lines}

    for line in lines:
        if RE_TITLE_PAGE.match(line):
            page["parliament"] = line
            break

    m = re.search(r'No\.\s*(\d+)\s+OF\s+(\d{4})', all_text, re.IGNORECASE)
    if m:
        page["number"] = int(m.group(1))
        page["year"]   = int(m.group(2))

    m = re.search(r'Certified\s+on\s+(.+?)[\.\]<]', all_text, re.IGNORECASE)
    if m:
        page["certified"] = m.group(1).strip()

    candidates = [
        l for l in lines
        if re.search(r'\bACT\b', l, re.IGNORECASE)
        and not _TITLE_NOISE.search(l)
        and 5 < len(l) < 120
    ]
    if candidates:
        title = min(candidates, key=len)
        title = re.sub(r'\s*,?\s*No\.\s*\d+.*', '', title, flags=re.IGNORECASE).strip()
        page["title"] = re.sub(r'\s+', ' ', title)

    return page


# ── Pass 2: build_document ────────────────────────────────────────────────────

def build_document(docling_json):
    """
    Build structured doc_json from serialised docling_json (no PDF needed).

    Page types:
      sparse — too few cells (blank pages, back matter)
      title  — cover page; fields extracted into doc["title_page"]
      text   — two-column layout; main structural body of the act
      other  — single-column, not a title page; goes to doc["rest"]

    sections in the returned doc is a dict:
      "47"      → normal section
      "XXIII/1" → collision: same number appeared in a second part
    """
    pages_raw  = docling_json.get("pages", [])
    pages_data = []

    # Accumulated cover page object — may span more than one title page.
    tp = {"parliament": None, "title": None, "number": None,
          "year": None, "certified": None, "lines": []}

    # Fallback cover metadata from page 0 (old extraction path, kept for acts
    # whose title page is not detected by RE_TITLE_PAGE).
    meta = extract_cover_metadata_d(pages_raw[0]["clusters"]) if pages_raw else {}

    # Build per-page table lookup from docling table structure (do_table_structure=True)
    tables_by_page = {}
    for t in docling_json.get("tables", []):
        idx = t.get("page_idx")
        if idx is not None and t.get("bbox_t") is not None:
            tables_by_page.setdefault(idx, {})[t["bbox_t"]] = t["rows"]

    for pg_idx, pg in enumerate(pages_raw):
        table_lookup = tables_by_page.get(pg_idx)
        clusters_d = pg["clusters"]
        ptype      = pg.get("page_type") or detect_page_type_d(clusters_d)

        # Upgrade stored 'other' → 'title' for docling_json written before
        # title-page detection was added to stage 1.
        if ptype == 'other':
            body = [cl for cl in clusters_d if not dis_header_footer(cl)]
            for cl in body[:5]:
                t = dcells_text(cl["cells"]).strip()
                if t and RE_TITLE_PAGE.match(t):
                    ptype = 'title'
                    break

        if ptype == 'title':
            page_data = extract_title_page_d(clusters_d)
            tp["lines"].extend(page_data["lines"])
            for key in ("parliament", "title", "number", "year", "certified"):
                if tp[key] is None and page_data[key] is not None:
                    tp[key] = page_data[key]
            pages_data.append(([], [], 'title'))

        elif ptype == 'sparse':
            pages_data.append(([], [], 'sparse'))

        elif ptype == 'text':
            main_e, marg_e = page_elements_d(clusters_d, table_lookup)
            pages_data.append((main_e, marg_e, 'text'))

        else:
            main_e, _ = page_elements_d(clusters_d, table_lookup)
            pages_data.append((main_e, [], 'other'))

    parts, sections, articles, schedules, rest, flags = build_structure(pages_data)

    title_page = tp if tp["lines"] else None

    return {
        "title_page":  title_page,
        "title":       (tp.get("title") or meta.get("title", "")),
        "number":      (tp.get("number") or meta.get("number")),
        "year":        (tp.get("year")   or meta.get("year")),
        "certified":   (tp.get("certified") or meta.get("certified")),
        "total_pages": docling_json.get("total_pages"),
        "parts":       parts,
        "sections":    sections,
        "articles":    articles,
        "schedules":   schedules,
        "rest":        rest,
        "flags":       flags,
    }


# ── CLI extractor (uses docling objects directly) ─────────────────────────────

def extract_act(pdf_path, output_path=None, verbose=True):
    pdf_path = Path(pdf_path)
    if output_path is None:
        output_path = pdf_path.with_suffix('.json')

    if verbose:
        print(f"Converting {pdf_path} with docling...")
    converter = build_converter()
    result    = converter.convert(str(pdf_path.resolve()))

    total_pages = len(pdfium.PdfDocument(str(pdf_path)))
    pages_raw   = []

    for pg_idx in range(total_pages):
        if pg_idx >= len(result.pages):
            break
        clusters = result.pages[pg_idx].predictions.layout.clusters
        ptype    = detect_page_type(clusters)
        pages_raw.append({
            "index":      pg_idx,
            "page_type":  ptype,
            "clusters":   serialize_clusters(clusters),
        })

    docling_json = {"total_pages": total_pages, "pages": pages_raw}
    act          = build_document(docling_json)
    act["source"] = str(pdf_path)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(act, f, indent=2, ensure_ascii=False)

    if verbose:
        flag_str = f"  flags: {act['flags']}" if act['flags'] else ""
        print(f"\n→ {len(act['sections'])} sections, {len(act['parts'])} parts, "
              f"{len(act.get('schedules', []))} schedule(s), "
              f"{len(act.get('rest', []))} rest chunk(s)  →  {output_path}{flag_str}")

    return act


# ── Query helpers ─────────────────────────────────────────────────────────────

def section_full_text(section):
    lines = []

    def add_item(item, indent=2):
        lines.append(f"{'  ' * indent}{item['label']} {item['text']}")
        for child in item.get('items', []):
            add_item(child, indent + 1)

    def add(node):
        t = node.get('type', '')
        if t == 'text':
            lines.append(node['text'])
        elif t in ('subsection', 'chapter_header'):
            num = node.get('number', '')
            lines.append(f"({num}) {node.get('text', node.get('title', ''))}")
            for item in node.get('items', []):
                add_item(item)
        elif t == 'list_item':
            add_item(node, indent=1)
        elif t == 'proviso':
            lines.append(f"  Provided: {node['text']}")

    for node in section.get('body', []):
        add(node)
    return '\n'.join(lines)


def print_section(act, number):
    secs = act['sections']
    if isinstance(secs, dict):
        s = secs.get(str(number))
    else:
        s = next((x for x in secs if x.get('number') == number), None)
    if not s:
        print(f"Section {number} not found.")
        return
    print(f"\nSection {s['number']}  —  {s['short_title'] or '(no title)'}")
    print(f"Part: {s['part']}")
    print("-" * 60)
    print(section_full_text(s))


def search_sections(act, query):
    q       = query.lower()
    results = []
    secs    = act['sections']
    items   = secs.values() if isinstance(secs, dict) else secs
    for s in items:
        full = section_full_text(s).lower()
        if q in full or (s['short_title'] and q in s['short_title'].lower()):
            results.append((s['number'], s['short_title']))
    results.sort()
    return results


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    path = Path(args[0])

    # --build: run Pass 2 on a saved docling_json file
    #   extract_act.py <docling.json> --build [out.json]
    if '--build' in args and path.suffix == '.json':
        with open(path) as f:
            docling_json = json.load(f)
        act = build_document(docling_json)
        idx = args.index('--build')
        out_arg = args[idx + 1] if idx + 1 < len(args) and not args[idx + 1].startswith('--') else None
        out_path = Path(out_arg) if out_arg else path.with_name(path.stem + '_doc.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(act, f, indent=2, ensure_ascii=False)
        flag_str = f"  flags: {act['flags']}" if act['flags'] else ""
        print(f"→ {len(act['sections'])} sections, {len(act['parts'])} parts, "
              f"{len(act.get('rest', []))} rest chunk(s)  →  {out_path}{flag_str}")
        sys.exit(0)

    # Query mode: load existing doc_json
    if path.suffix == '.json' and len(args) > 1 and '--build' not in args:
        with open(path) as f:
            act = json.load(f)
        secs = act['sections']
        print(f"{act['title']} (No. {act['number']} of {act['year']})")
        print(f"{len(secs)} sections, {len(act['parts'])} parts, "
              f"{len(act.get('appendices', []))} appendix chunks")

        if '--section' in args:
            idx = args.index('--section')
            print_section(act, int(args[idx + 1]))
        elif '--search' in args:
            idx = args.index('--search')
            hits = search_sections(act, args[idx + 1])
            print(f"\nMatches for '{args[idx+1]}':")
            for num, title in hits:
                print(f"  §{num}  {title or ''}")
        sys.exit(0)

    # Extraction mode: PDF → docling_json → doc_json
    out = Path(args[1]) if len(args) > 1 and not args[1].startswith('--') else None
    act = extract_act(path, out)

    print(f"\n{act['title']} — No. {act['number']} of {act['year']}")
    secs = act['sections']
    nums = sorted(k for k in secs if '/' not in str(k))
    try:
        nums_int = sorted(int(k) for k in nums)
        print(f"Sections: {nums_int[:15]}{'...' if len(nums_int) > 15 else ''}")
    except ValueError:
        print(f"Sections: {nums[:15]}{'...' if len(nums) > 15 else ''}")
    if act['parts']:
        for p in act['parts']:
            print(f"  Part {p['number']}: {p['title'][:60]}  ({len(p['sections'])} sections)")
