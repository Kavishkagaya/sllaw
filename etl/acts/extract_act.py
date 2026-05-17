#!/usr/bin/env python3
"""
extract_act.py — Sri Lanka Legal Act Structured Extractor

Usage:
  .venv/bin/python3 extract_act.py <pdf>              → <pdf>.json
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
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

# ── Pattern matchers ──────────────────────────────────────────────────────────

RE_SECTION   = re.compile(r'^(\d+)\.\s*(.*)', re.DOTALL)
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

GAP_MIN_PT       = 8    # minimum column gap width in PDF points
MIN_CELLS_BODY   = 8    # pages with fewer cells → cover or back-page


# ── Docling setup ─────────────────────────────────────────────────────────────

def build_converter():
    opts = PdfPipelineOptions()
    opts.do_ocr = False
    opts.do_table_structure = False
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=opts,
                backend=PyPdfiumDocumentBackend,
            )
        }
    )


# ── Cell / cluster utilities ──────────────────────────────────────────────────

def cell_cx(cell):
    return (cell.rect.r_x0 + cell.rect.r_x2) / 2


def cell_x_range(cell):
    return (min(cell.rect.r_x0, cell.rect.r_x1, cell.rect.r_x2, cell.rect.r_x3),
            max(cell.rect.r_x0, cell.rect.r_x1, cell.rect.r_x2, cell.rect.r_x3))


def cell_y_range(cell):
    return (min(cell.rect.r_y0, cell.rect.r_y1, cell.rect.r_y2, cell.rect.r_y3),
            max(cell.rect.r_y0, cell.rect.r_y1, cell.rect.r_y2, cell.rect.r_y3))


def cells_text(cells):
    """Reconstruct text from ordered cells, collapsing hyphenation."""
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


# ── Column gap detection ──────────────────────────────────────────────────────

def find_column_gap(clusters):
    """
    Find the largest horizontal gap between cell x-extents across all clusters.
    Returns (gap_center, gap_left, gap_right) or None.
    """
    intervals = []
    for cl in clusters:
        for cell in cl.cells:
            x0, x1 = cell_x_range(cell)
            if x1 > x0:
                intervals.append((x0, x1))
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


# ── Page type + element extraction ───────────────────────────────────────────

def detect_page_type(clusters):
    all_cells = [c for cl in clusters for c in cl.cells]
    if len(all_cells) < MIN_CELLS_BODY:
        return 'sparse'   # cover or back-page

    body = [cl for cl in clusters if not is_header_footer(cl)]
    gap = find_column_gap(body)
    return 'text' if gap else 'other'   # 'other' = table/schedule or cover


def page_elements(clusters):
    """
    Split a text-act page into (main_elements, marginal_elements).
    Each element: {'text', 'y_top', 'y_bot', 'label'}
    Elements are sorted by y_top (reading order top→bottom).
    """
    body = [cl for cl in clusters if not is_header_footer(cl)]
    gap_result = find_column_gap(body)
    if not gap_result:
        # Treat everything as main if no gap found
        elems = []
        for cl in sorted(body, key=lambda c: c.bbox.t):
            t = cells_text(cl.cells)
            if t:
                elems.append({'text': t, 'y_top': cl.bbox.t, 'y_bot': cl.bbox.b,
                               'label': cluster_label(cl)})
        return elems, []

    gap_center, _, _ = gap_result

    # Determine which side carries more content → that is main
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
            # Filter bare page numbers and very short strings
            if t and not RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                y0, y1 = cells_y_span(marg_cells)
                marg_elems.append({'text': t, 'y_top': y0, 'y_bot': y1})

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

    return 'text', None, t


def marginal_at(marg_elems, y_top, y_bot):
    """
    Collect all marginal texts whose y-range overlaps [y_top, y_bot] and join them.
    Handles split marginal notes (multi-line marginal rendered as separate clusters).
    """
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
    Walk (main_elems, marg_elems, page_type) for each page in order.
    page_type: 'text' | 'other' | 'sparse'
    Returns (parts, sections_list, appendices).
    """
    parts = []
    sections = []          # list of section dicts (preserves duplicates across parts)
    appendices = []        # raw text from 'other' pages and schedule content
    _appendix_buf = []     # accumulator for consecutive raw-content lines
    flags = []             # extraction quality issues detected
    current_part = None
    current_section = None
    awaiting_part_title = False
    in_schedule = False    # true once a SCHEDULE/TABLE/FORM header is seen
    _seen_sec_nums = {}    # number → first part that used it (collision detection)
    _max_sec_num = 0       # highest section number seen (regression detection)

    def flush_appendix():
        if _appendix_buf:
            appendices.append({"text": "\n".join(_appendix_buf)})
            _appendix_buf.clear()

    def open_section(number, short_title, part_number):
        return {
            'number': number,
            'short_title': short_title,
            'part': part_number,
            'body': [],
        }

    def flush():
        nonlocal current_section, _max_sec_num
        if current_section:
            num = current_section['number']
            part = current_section.get('part', '?')
            # Collision: same number already used in a different part
            if num in _seen_sec_nums and _seen_sec_nums[num] != part:
                flags.append(f"section_collision:s{num}_parts_{_seen_sec_nums[num]},{part}")
            else:
                _seen_sec_nums[num] = part
            # Regression: number dropped to < 10% of previous high → schedule leaking in
            if _max_sec_num > 10 and num < _max_sec_num * 0.1:
                flags.append(f"section_regression:{_max_sec_num}_to_{num}")
            _max_sec_num = max(_max_sec_num, num)
            sections.append(current_section)
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

        # 'other' pages (schedules, forms, tables): collect raw text, skip section parsing
        if page_type == 'other':
            for elem in main_elems:
                t = elem['text'].strip()
                if t and not RE_PRINT_REF.match(t):
                    _appendix_buf.append(t)
            continue

        flush_appendix()  # end any accumulated 'other' run before resuming sections

        for elem in main_elems:
            # Skip print-run references (e.g. "2 —PP 012867– 5,000 (2000/09)")
            if RE_PRINT_REF.match(elem['text'].strip()):
                continue

            kind, num, rest = classify(elem['text'])

            # Once a schedule/table/form header is seen, everything after is appendix
            if kind == 'schedule_header':
                flush()
                flush_appendix()
                if not in_schedule:
                    flags.append(f"schedule_keyword:{elem['text'].strip()[:40]}")
                in_schedule = True
                _appendix_buf.append(elem['text'].strip())
                continue

            if in_schedule:
                _appendix_buf.append(elem['text'].strip())
                continue

            # Backfill part/chapter title from the next ALL-CAPS text element
            # (but don't consume another structural header as a title)
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
                # Promote to top-level if: no part open yet, OR all parts so far
                # were themselves opened by chapter headers (chapter-only acts).
                all_chapters = all(p.get('type') == 'chapter' for p in parts)
                if current_part is None or (parts and all_chapters):
                    flush()
                    current_part = {'number': num, 'title': rest, 'sections': [], 'type': 'chapter'}
                    parts.append(current_part)
                    if not rest:
                        awaiting_part_title = True
                else:
                    # Chapter nests inside a part — record as sub-grouping label
                    add_to_body({'type': 'chapter_header', 'number': num, 'title': rest})
                    if not rest:
                        awaiting_part_title = True

            elif kind == 'section_opener':
                flush()
                short = marginal_at(marg_elems, elem['y_top'], elem['y_bot'])
                current_section = open_section(
                    int(num), short,
                    current_part['number'] if current_part else None
                )
                if current_part:
                    current_part['sections'].append(int(num))

                # Handle text on same line as section number
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
                # Attach to last list_item in the last subsection
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

            else:  # plain text
                add_to_body({'type': 'text', 'text': rest})

    flush()
    flush_appendix()
    if appendices:
        flags.append(f"appendix_content:{len(appendices)}_chunks")
    return parts, sections, appendices, flags


# ── Cover metadata ────────────────────────────────────────────────────────────

def extract_cover_metadata(clusters):
    meta = {}
    all_text = ' '.join(cells_text(cl.cells) for cl in clusters if cl.cells)

    m = re.search(r'No\.\s*(\d+)\s+OF\s+(\d{4})', all_text, re.IGNORECASE)
    if m:
        meta['number'] = int(m.group(1))
        meta['year']   = int(m.group(2))

    m = re.search(r'Certified\s+on\s+(.+?)[\.\]<]', all_text, re.IGNORECASE)
    if m:
        meta['certified'] = m.group(1).strip()

    # Title: cluster that looks like "<WORDS> ACT" — short, no URLs or publication noise
    _TITLE_NOISE = re.compile(
        r'www\.|downloaded|Gazette|Published|Supplement|Printed|purchased|'
        r'Parliament of the|PARLIAMENT OF', re.IGNORECASE
    )
    candidates = []
    for cl in clusters:
        t = cells_text(cl.cells).strip()
        if (re.search(r'\bACT\b', t, re.IGNORECASE)
                and not _TITLE_NOISE.search(t)
                and 5 < len(t) < 120):
            candidates.append(t)
    if candidates:
        # Prefer shortest candidate that still contains "ACT" — avoids long preamble text
        title = min(candidates, key=len)
        title = re.sub(r'\s*,?\s*No\.\s*\d+.*', '', title, flags=re.IGNORECASE).strip()
        meta['title'] = re.sub(r'\s+', ' ', title)

    return meta


# ── Main extractor ────────────────────────────────────────────────────────────

def extract_act(pdf_path, output_path=None, verbose=True):
    pdf_path = Path(pdf_path)
    if output_path is None:
        output_path = pdf_path.with_suffix('.json')

    if verbose:
        print(f"Converting {pdf_path} with docling...")
    converter = build_converter()
    result = converter.convert(str(pdf_path.resolve()))

    total_pages = len(pdfium.PdfDocument(str(pdf_path)))
    meta = {}
    pages_data = []

    for pg_idx in range(total_pages):
        if pg_idx >= len(result.pages):
            break
        clusters = result.pages[pg_idx].predictions.layout.clusters
        ptype = detect_page_type(clusters)

        if pg_idx == 0:
            meta.update(extract_cover_metadata(clusters))

        if ptype == 'sparse':
            pages_data.append(([], [], 'sparse'))
        elif ptype == 'text':
            main_e, marg_e = page_elements(clusters)
            pages_data.append((main_e, marg_e, 'text'))
            if verbose and pg_idx < 5:
                print(f"  p{pg_idx+1}: {len(main_e)} main / {len(marg_e)} marginal elements")
        else:  # 'other': table/schedule page — keep text, skip section parsing
            main_e, _ = page_elements(clusters)
            pages_data.append((main_e, [], 'other'))

    if verbose:
        print("Building structure...")
    parts, sections, appendices, flags = build_structure(pages_data)

    act = {
        'title':       meta.get('title', ''),
        'number':      meta.get('number'),
        'year':        meta.get('year'),
        'certified':   meta.get('certified'),
        'source':      str(pdf_path),
        'total_pages': total_pages,
        'parts':       parts,
        'sections':    sections,
        'appendices':  appendices,
        'flags':       flags,
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(act, f, indent=2, ensure_ascii=False)

    if verbose:
        flag_str = f"  flags: {flags}" if flags else ""
        print(f"\n→ {len(sections)} sections, {len(parts)} parts, {len(appendices)} appendix chunk(s)  →  {output_path}{flag_str}")

    return act


# ── Query helpers ─────────────────────────────────────────────────────────────

def section_full_text(section):
    """Flatten section body to plain text."""
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
    # Support both old dict format and new list format
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
    q = query.lower()
    results = []
    secs = act['sections']
    items = secs.values() if isinstance(secs, dict) else secs
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

    # Query mode: load existing JSON
    if path.suffix == '.json' and len(args) > 1:
        with open(path) as f:
            act = json.load(f)
        print(f"{act['title']} (No. {act['number']} of {act['year']})")
        print(f"{len(act['sections'])} sections, {len(act['parts'])} parts, {len(act.get('appendices', []))} appendix chunks")

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

    # Extraction mode
    out = Path(args[1]) if len(args) > 1 and not args[1].startswith('--') else None
    act = extract_act(path, out)

    print(f"\n{act['title']} — No. {act['number']} of {act['year']}")
    nums = sorted(int(k) for k in act['sections'])
    print(f"Sections: {nums[:15]}{'...' if len(nums) > 15 else ''}")
    if act['parts']:
        for p in act['parts']:
            print(f"  Part {p['number']}: {p['title'][:60]}  ({len(p['sections'])} sections)")
