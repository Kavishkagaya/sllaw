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

# Structural patterns we don't yet handle — trigger flag-and-stop in build_structure
RE_STRUCTURAL_ALARM = re.compile(
    r'^SECTION\s+\d'               # written-out SECTION 5
    r'|^ARTICLE\s+\d'              # ARTICLE heading
    r'|^DIVISION\s+[IVXLC\d]',    # DIVISION heading
    re.IGNORECASE,
)

GAP_MIN_PT     = 8   # minimum column gap width in PDF points
MIN_CELLS_BODY = 8   # pages with fewer cells → cover or back-page


# ── Docling setup ─────────────────────────────────────────────────────────────

def build_converter():
    opts = PdfPipelineOptions(
        do_ocr=False,
        do_table_structure=False,
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
    all_cells = [c for cl in clusters for c in cl.cells]
    if len(all_cells) < MIN_CELLS_BODY:
        return 'sparse'
    body = [cl for cl in clusters if not is_header_footer(cl)]
    gap = find_column_gap(body)
    return 'text' if gap else 'other'


def detect_page_type_d(clusters_d):
    all_cells = [c for cl in clusters_d for c in cl["cells"]]
    if len(all_cells) < MIN_CELLS_BODY:
        return 'sparse'
    body = [cl for cl in clusters_d if not dis_header_footer(cl)]
    gap = find_column_gap_d(body)
    return 'text' if gap else 'other'


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
                elems.append({'text': t, 'y_top': cl.bbox.t, 'y_bot': cl.bbox.b,
                               'label': cluster_label(cl)})
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
                main_elems.append({'text': t, 'y_top': y0, 'y_bot': y1, 'label': lbl})
        if marg_cells:
            t = cells_text(marg_cells)
            if t and not RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                y0, y1 = cells_y_span(marg_cells)
                marg_elems.append({'text': t, 'y_top': y0, 'y_bot': y1})
    return main_elems, marg_elems


def page_elements_d(clusters_d):
    """Dict version: split page into (main_elements, marginal_elements)."""
    body = [cl for cl in clusters_d if not dis_header_footer(cl)]
    gap_result = find_column_gap_d(body)
    if not gap_result:
        elems = []
        for cl in sorted(body, key=lambda c: c["bbox"]["t"]):
            t = dcells_text(cl["cells"])
            if t:
                elems.append({'text': t, 'y_top': cl["bbox"]["t"], 'y_bot': cl["bbox"]["b"],
                               'label': cl["label"]})
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
            t = dcells_text(main_cells)
            if t:
                ys = [y for c in main_cells for y in (c["y0"], c["y1"])]
                main_elems.append({'text': t, 'y_top': min(ys), 'y_bot': max(ys), 'label': lbl})
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
    kind ∈ section_opener | part_header | chapter_header | subsection |
            list_item | sub_item | proviso | schedule_header | text
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
        return 'sub_item', m.group(1).lower(), m.group(2).strip()

    if RE_STRUCTURAL_ALARM.match(t):
        return 'unknown', None, t

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


# ── Hierarchy builder ─────────────────────────────────────────────────────────

def build_structure(pages_data):
    """
    Walk (main_elems, marg_elems, page_type) for each page.
    page_type: 'text' | 'other' | 'sparse'

    sections is a dict:
      - normal key  : str(section_number)   e.g. "47"
      - collision   : "PART/number"         e.g. "XXIII/1"  (flagged)

    Returns (parts, sections_dict, schedules, appendices, flags, stopped).
    """
    parts            = []
    sections         = {}       # key: str(num) or "PART/num" on collision
    schedules        = []       # list of {"name": str, "content": [str, ...]}
    appendices       = []
    _appendix_buf    = []
    _sched_buf       = None     # active schedule being accumulated
    flags            = []
    current_part     = None
    current_section  = None
    awaiting_part_title = False
    in_schedule      = False
    _seen_sec_nums   = {}       # int num → part (first occurrence)
    _max_sec_num     = 0

    def flush_appendix():
        if _appendix_buf:
            appendices.append({"text": "\n".join(_appendix_buf)})
            _appendix_buf.clear()

    def flush_schedule():
        nonlocal _sched_buf
        if _sched_buf is not None:
            schedules.append(_sched_buf)
            _sched_buf = None

    def open_section(number, short_title, part_number):
        return {'number': number, 'short_title': short_title, 'part': part_number, 'body': []}

    def flush():
        nonlocal current_section, _max_sec_num
        if not current_section:
            return
        num  = current_section['number']
        part = current_section.get('part', '?')
        key  = str(num)

        if key in sections:
            # Collision: same section number already used in another part — must flag, never overwrite
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
            pass  # alphanumeric section number — skip regression check
        current_section = None

    def add_to_body(node):
        if current_section is not None:
            current_section['body'].append(node)

    def last_body_node(of_type=None):
        if not current_section:
            return None
        body = current_section['body']
        for node in reversed(body):
            if of_type is None or node['type'] == of_type:
                return node
        return None

    for entry in pages_data:
        main_elems, marg_elems, page_type = entry if len(entry) == 3 else (*entry, 'text')

        if page_type == 'other':
            for elem in main_elems:
                t = elem['text'].strip()
                if t and not RE_PRINT_REF.match(t):
                    _appendix_buf.append(t)
            continue

        flush_appendix()

        for elem in main_elems:
            if RE_PRINT_REF.match(elem['text'].strip()):
                continue

            kind, num, rest = classify(elem['text'])

            if kind == 'schedule_header':
                flush()
                flush_appendix()
                flush_schedule()
                flags.append(f"schedule_keyword:{elem['text'].strip()[:40]}")
                _sched_buf = {"name": elem['text'].strip(), "content": []}
                in_schedule = True
                continue

            if in_schedule:
                t = elem['text'].strip()
                if t and _sched_buf is not None:
                    _sched_buf["content"].append(t)
                continue

            if kind == 'unknown':
                flags.append(f"unknown_pattern:{elem['text'].strip()[:60]}")
                flush()
                flush_appendix()
                flush_schedule()
                return parts, sections, schedules, appendices, flags, True

            if awaiting_part_title and kind == 'text' and elem['text'].strip().isupper():
                current_part['title'] = elem['text'].strip()
                awaiting_part_title = False
                continue

            if kind not in ('part_header', 'chapter_header'):
                awaiting_part_title = False

            if kind == 'part_header':
                flush()
                current_part = {'number': num, 'title': rest, 'sections': []}
                parts.append(current_part)
                if not rest:
                    awaiting_part_title = True

            elif kind == 'chapter_header':
                all_chapters = all(p.get('type') == 'chapter' for p in parts)
                if current_part is None or (parts and all_chapters):
                    flush()
                    current_part = {'number': num, 'title': rest, 'sections': [], 'type': 'chapter'}
                    parts.append(current_part)
                    if not rest:
                        awaiting_part_title = True
                else:
                    add_to_body({'type': 'chapter_header', 'number': num, 'title': rest})
                    if not rest:
                        awaiting_part_title = True

            elif kind == 'section_opener':
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
                if current_part:
                    current_part['sections'].append(sec_num)

                if rest:
                    k2, n2, r2 = classify(rest)
                    if k2 == 'subsection':
                        add_to_body({'type': 'subsection', 'number': n2, 'text': r2, 'items': []})
                    elif k2 == 'list_item':
                        add_to_body({'type': 'list_item', 'label': f'({n2})', 'text': r2, 'sub_items': []})
                    elif k2 == 'proviso':
                        add_to_body({'type': 'proviso', 'text': r2})
                    else:
                        add_to_body({'type': 'text', 'text': rest})

            elif kind == 'subsection':
                add_to_body({'type': 'subsection', 'number': num, 'text': rest, 'items': []})

            elif kind == 'list_item':
                item = {'label': f'({num})', 'text': rest, 'sub_items': []}
                parent = last_body_node('subsection')
                if parent:
                    parent['items'].append(item)
                else:
                    add_to_body({'type': 'list_item', **item})

            elif kind == 'sub_item':
                item = {'label': f'({num})', 'text': rest}
                attached = False
                if current_section:
                    for node in reversed(current_section['body']):
                        if node['type'] == 'subsection' and node.get('items'):
                            node['items'][-1].setdefault('sub_items', []).append(item)
                            attached = True
                            break
                        if node['type'] == 'list_item':
                            node.setdefault('sub_items', []).append(item)
                            attached = True
                            break
                if not attached:
                    add_to_body({'type': 'sub_item', **item})

            elif kind == 'proviso':
                add_to_body({'type': 'proviso', 'text': rest})

            else:
                add_to_body({'type': 'text', 'text': rest})

    flush()
    flush_appendix()
    flush_schedule()
    if appendices:
        flags.append(f"appendix_content:{len(appendices)}_chunks")
    return parts, sections, schedules, appendices, flags, False


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


# ── Pass 2: build_document ────────────────────────────────────────────────────

def build_document(docling_json):
    """
    Build structured doc_json from serialised docling_json (no PDF needed).

    sections in the returned doc is a dict:
      "47"      → normal section
      "XXIII/1" → collision: same number appeared in a second part (flagged)
    """
    pages_raw  = docling_json.get("pages", [])
    meta       = {}
    pages_data = []

    for pg in pages_raw:
        clusters_d = pg["clusters"]
        ptype      = pg.get("page_type") or detect_page_type_d(clusters_d)

        if pg["index"] == 0:
            meta.update(extract_cover_metadata_d(clusters_d))

        if ptype == 'sparse':
            pages_data.append(([], [], 'sparse'))
        elif ptype == 'text':
            main_e, marg_e = page_elements_d(clusters_d)
            pages_data.append((main_e, marg_e, 'text'))
        else:
            main_e, _ = page_elements_d(clusters_d)
            pages_data.append((main_e, [], 'other'))

    parts, sections, schedules, appendices, flags, stopped = build_structure(pages_data)

    return {
        "title":       meta.get("title", ""),
        "number":      meta.get("number"),
        "year":        meta.get("year"),
        "certified":   meta.get("certified"),
        "total_pages": docling_json.get("total_pages"),
        "parts":       parts,
        "sections":    sections,
        "schedules":   schedules,
        "appendices":  appendices,
        "flags":       flags,
        "stopped":     stopped,
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
        flag_str    = f"  flags: {act['flags']}" if act['flags'] else ""
        stopped_str = "  [STOPPED — unknown pattern, needs parser support]" if act.get("stopped") else ""
        print(f"\n→ {len(act['sections'])} sections, {len(act['parts'])} parts, "
              f"{len(act.get('schedules', []))} schedule(s), "
              f"{len(act['appendices'])} appendix chunk(s)  →  {output_path}{flag_str}{stopped_str}")

    return act


# ── Query helpers ─────────────────────────────────────────────────────────────

def section_full_text(section):
    lines = []

    def add(node):
        t = node.get('type', '')
        if t == 'text':
            lines.append(node['text'])
        elif t in ('subsection', 'chapter_header'):
            num = node.get('number', '')
            lines.append(f"({num}) {node.get('text', node.get('title', ''))}")
            for item in node.get('items', []):
                lines.append(f"  {item['label']} {item['text']}")
                for sub in item.get('sub_items', []):
                    lines.append(f"    {sub['label']} {sub['text']}")
        elif t == 'list_item':
            lines.append(f"  {node['label']} {node['text']}")
            for sub in node.get('sub_items', []):
                lines.append(f"    {sub['label']} {sub['text']}")
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
              f"{len(act['appendices'])} appendix chunk(s)  →  {out_path}{flag_str}")
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
