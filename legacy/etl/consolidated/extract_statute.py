#!/usr/bin/env python3
"""
extract_statute.py — Consolidated statute extractor

Two entry points:
  extract_statute(html)           — HTML files from lankalaw.net
  extract_statute_pdf(conv, path) — PDF files via docling (same pipeline as acts)

Both return:
  {title, description, enacted_date, is_repealed, parts, sections}
  sections[num] = {short_title, part, body}  — body is always plain text
"""

import re
import sys
from pathlib import Path
from typing import Optional

from bs4 import BeautifulSoup

# Make the acts extractor available for PDF parsing.
# sys.path manipulation is intentional — etl/acts/ is a sibling package.
_ACTS_DIR = Path(__file__).parent.parent / "acts"
if str(_ACTS_DIR) not in sys.path:
    sys.path.insert(0, str(_ACTS_DIR))

try:
    import pypdfium2 as pdfium  # noqa: F401 (used in extract_statute_pdf)
    from extract_act import (  # type: ignore[import]
        build_converter as _build_converter,
        build_structure as _build_structure,
        cell_cx as _cell_cx,
        cells_text as _cells_text,
        cells_y_span as _cells_y_span,
        cluster_label as _cluster_label,
        dcell_cx as _dcell_cx,
        dcells_text as _dcells_text,
        detect_page_type as _detect_page_type,
        detect_page_type_d as _detect_page_type_d,
        extract_cover_metadata as _extract_cover_metadata,
        extract_cover_metadata_d as _extract_cover_metadata_d,
        find_column_gap as _find_column_gap,
        find_column_gap_d as _find_column_gap_d,
        is_header_footer as _is_header_footer,
        page_elements as _page_elements,
        page_elements_d as _page_elements_d,
        RE_INTEGER as _RE_INTEGER,
        section_full_text as _section_full_text,
        serialize_clusters as _serialize_clusters,
    )
    _PDF_AVAILABLE = True
except ImportError:
    _PDF_AVAILABLE = False


def extract_statute(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    title = _extract_title(soup)
    description = _extract_description(soup)
    enacted_date = _extract_date(soup)
    is_repealed = _is_repealed(soup)
    parts, sections = _extract_structure(soup)

    return {
        "title": title,
        "description": description,
        "enacted_date": enacted_date,
        "is_repealed": is_repealed,
        "parts": parts,
        "sections": sections,
    }


# ── Field extractors ──────────────────────────────────────────────────────────

def _extract_title(soup: BeautifulSoup) -> str:
    el = soup.find("font", class_="actname")
    if el:
        return el.get_text(strip=True)
    title_tag = soup.find("title")
    return title_tag.get_text(strip=True) if title_tag else ""


def _extract_description(soup: BeautifulSoup) -> str:
    el = soup.find(class_="descriptionhead")
    return el.get_text(strip=True) if el else ""


def _extract_date(soup: BeautifulSoup) -> Optional[str]:
    for td in soup.find_all("td", attrs={"align": "right"}):
        text = td.get_text(" ", strip=True)
        m = re.search(r'\[([^\]]+)\]', text)
        if m:
            raw = re.sub(r'\s+', ' ', m.group(1)).strip()
            if raw:
                return raw
    return None


def _is_repealed(soup: BeautifulSoup) -> bool:
    # Repealed statutes have a red notice in <p class="actinfo">
    el = soup.find("p", class_="actinfo")
    if el and "repeal" in el.get_text().lower():
        return True
    # Also check if the actname itself says "repealed"
    actname = soup.find("font", class_="actname")
    if actname and "repeal" in actname.get_text().lower():
        return True
    return False


# ── HTML body node classifiers ────────────────────────────────────────────────

_RE_HTML_SUBSEC  = re.compile(r'^\((\d+[A-Za-z]?)\)\s*(.*)', re.DOTALL)
_RE_HTML_LIST    = re.compile(r'^\(([a-z]{1,3})\)\s*(.*)', re.DOTALL)
_RE_HTML_PROVISO = re.compile(r'^Provided\b', re.IGNORECASE)


def _subsec_own_text(el) -> str:
    """Text of a subsectioncontent element, ignoring its nested table children."""
    parts = []
    for child in el.children:
        if getattr(child, 'name', None) == 'table':
            continue
        t = child.get_text(' ', strip=True) if hasattr(child, 'get_text') else str(child).strip()
        if t:
            parts.append(t)
    return ' '.join(parts).strip()


def _build_body_nodes(content_el) -> list:
    """
    Parse a font.sectioncontent element into structured body nodes.
    Returns the same node types as the PDF path:
      subsection, list_item, sub_item, proviso, text
    Marginal notes (short_title) are NOT in the content_el — they are in
    the sibling sectionshorttitle cell and handled separately.
    """
    nodes: list = []

    # ── Intro text (between section-number font and first table) ──
    intro_parts = []
    for child in content_el.children:
        cname = getattr(child, 'name', None)
        if cname == 'table':
            break
        if cname == 'font':
            if 'subsectioncontent' in (child.get('class') or []):
                break
            if child.get('style'):   # bold section-number wrapper — skip
                continue
        t = child.get_text(' ', strip=True) if hasattr(child, 'get_text') \
            else str(child).strip()
        t = t.lstrip('. ')
        if t:
            intro_parts.append(t)
    intro = ' '.join(intro_parts).strip()
    if intro:
        nodes.append({"type": "text", "text": intro})

    # ── Collect all subsectioncontent with depth ──────────────────
    flat: list[dict] = []
    for sub in content_el.find_all('font', class_='subsectioncontent'):
        depth = sum(
            1 for p in sub.parents
            if getattr(p, 'name', None) == 'font'
            and 'subsectioncontent' in (p.get('class') or [])
        )
        text = _subsec_own_text(sub)
        if not text:
            continue

        if _RE_HTML_PROVISO.match(text):
            flat.append({'type': 'proviso', 'text': text, '_d': depth})
            continue

        m = _RE_HTML_SUBSEC.match(text)
        if m:
            flat.append({'type': 'subsection', 'number': m.group(1),
                         'text': m.group(2).strip(), 'items': [], '_d': depth})
            continue

        m = _RE_HTML_LIST.match(text)
        if m:
            label, rest = f'({m.group(1)})', m.group(2).strip()
            lbl = m.group(1)
            # True roman sub-items: (i) alone, or multi-char sequences like (ii)(iii)(iv)
            # Single chars like (c)(v)(x)(l)(m) are list_items even though they're
            # valid roman digits — they only appear as sub_items when multi-char.
            is_roman = (lbl == 'i') or (len(lbl) >= 2 and all(c in 'ivxlcdm' for c in lbl))
            node_type = 'sub_item' if (is_roman and depth >= 1) else 'list_item'
            if node_type == 'list_item':
                flat.append({'type': 'list_item', 'label': label,
                             'text': rest, 'sub_items': [], '_d': depth})
            else:
                flat.append({'type': 'sub_item', 'label': label,
                             'text': rest, '_d': depth})
            continue

        flat.append({'type': 'text', 'text': text, '_d': depth})

    # ── Nest flat nodes into subsection.items / list_item.sub_items ──
    cur_sub: dict | None = None
    cur_li:  dict | None = None

    for node in flat:
        d = node.pop('_d', 0)
        t = node['type']

        if t == 'subsection':
            nodes.append(node)
            cur_sub, cur_li = node, None

        elif t == 'list_item':
            if cur_sub is not None and d > 0:
                cur_sub['items'].append(node)
            else:
                nodes.append(node)
                cur_sub = None
            cur_li = node

        elif t == 'sub_item':
            if cur_li is not None:
                cur_li['sub_items'].append(node)
            else:
                nodes.append(node)
            # don't reset cur_sub/cur_li

        else:  # text / proviso
            nodes.append(node)
            cur_sub, cur_li = None, None

    return nodes


def _parse_marginal(short_el) -> tuple[str, list[str]]:
    """
    Return (short_title, amendments) from a font.sectionshorttitle element.
    Amendment references live in <tr class="morginalnotes"> and are kept
    separate from the short title text.
    """
    amendments = []
    for tr in short_el.find_all('tr', class_='morginalnotes'):
        t = tr.get_text(' ', strip=True)
        if t:
            amendments.append(t)

    # Title = all text except the amendment table and <br>
    parts = []
    for child in short_el.children:
        cname = getattr(child, 'name', None)
        if cname in ('table', 'br'):
            continue
        t = child.get_text(' ', strip=True) if hasattr(child, 'get_text') \
            else str(child).strip()
        if t:
            parts.append(t)

    title = ' '.join(parts).strip().rstrip('.')
    return title, amendments


# ── Structure extraction ──────────────────────────────────────────────────────

def _extract_structure(soup: BeautifulSoup) -> tuple[list, dict]:
    """
    Walk all font.sectionpart and font.sectionshorttitle elements in document
    order to build parts list and sections dict keyed by section number string.
    """
    parts: list[dict] = []
    sections: dict[str, dict] = {}

    current_part: Optional[str] = None
    current_part_sections: list[str] = []

    markers = soup.find_all("font", class_=lambda c: c and (
        "sectionpart" in c or "sectionshorttitle" in c
    ))

    for el in markers:
        classes = el.get("class", [])

        if "sectionpart" in classes:
            _flush_part(parts, current_part, current_part_sections)
            current_part = el.get_text(strip=True)
            current_part_sections = []

        elif "sectionshorttitle" in classes:
            short_title, amendments = _parse_marginal(el)

            tr = el.find_parent("tr")
            if tr is None:
                continue
            content_el = tr.find("font", class_="sectioncontent")
            if content_el is None:
                continue

            section_num = _section_number(content_el)
            if section_num is None:
                continue

            sections[section_num] = {
                "short_title": short_title or None,
                "amendments":  amendments,
                "part":        current_part,
                "body":        _build_body_nodes(content_el),
            }
            current_part_sections.append(section_num)

    _flush_part(parts, current_part, current_part_sections)
    return parts, sections


def _flush_part(parts: list, name: Optional[str], section_nums: list) -> None:
    if name is not None:
        parts.append({
            "number": name,
            "title": "",
            "sections": section_nums,
            "type": "part",
        })


def _section_number(content_el) -> Optional[str]:
    """Return the section number string from a font.sectioncontent element."""
    a_tag = content_el.find("a")
    if a_tag is None:
        return None
    num = a_tag.get_text(strip=True)
    return num if num else None


# ── PDF extraction (docling) ──────────────────────────────────────────────────

def _page_elements_at(clusters, gap_center: float):
    """
    Split page clusters into (main_elems, marg_elems) using a fixed gap_center
    instead of the dynamic per-page gap detection.  Works the same as
    page_elements() but never falls back to single-column mode.
    """
    body = [cl for cl in clusters if not _is_header_footer(cl)]

    left_n  = sum(1 for cl in body for c in cl.cells if _cell_cx(c) < gap_center)
    right_n = sum(1 for cl in body for c in cl.cells if _cell_cx(c) >= gap_center)
    main_is_left = left_n >= right_n

    main_elems: list = []
    marg_elems: list = []

    for cl in sorted(body, key=lambda c: c.bbox.t):
        left_cells  = [c for c in cl.cells if _cell_cx(c) < gap_center]
        right_cells = [c for c in cl.cells if _cell_cx(c) >= gap_center]

        main_cells = left_cells  if main_is_left else right_cells
        marg_cells = right_cells if main_is_left else left_cells
        lbl        = _cluster_label(cl)

        if main_cells:
            t = _cells_text(main_cells)
            if t:
                y0, y1 = _cells_y_span(main_cells)
                main_elems.append({"text": t, "y_top": y0, "y_bot": y1, "label": lbl})

        if marg_cells:
            t = _cells_text(marg_cells)
            if t and not _RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                y0, y1 = _cells_y_span(marg_cells)
                marg_elems.append({"text": t, "y_top": y0, "y_bot": y1})

    return main_elems, marg_elems


def _page_elements_at_d(clusters_d: list, gap_center: float):
    """Dict-cluster version of _page_elements_at with a fixed gap_center."""
    body = [cl for cl in clusters_d if cl["label"] not in ("page_header", "page_footer")]

    left_n  = sum(1 for cl in body for c in cl["cells"] if _dcell_cx(c) < gap_center)
    right_n = sum(1 for cl in body for c in cl["cells"] if _dcell_cx(c) >= gap_center)
    main_is_left = left_n >= right_n

    main_elems, marg_elems = [], []
    for cl in sorted(body, key=lambda c: c["bbox"]["t"]):
        left_cells  = [c for c in cl["cells"] if _dcell_cx(c) < gap_center]
        right_cells = [c for c in cl["cells"] if _dcell_cx(c) >= gap_center]
        main_cells  = left_cells  if main_is_left else right_cells
        marg_cells  = right_cells if main_is_left else left_cells
        lbl         = cl["label"]

        if main_cells:
            t = _dcells_text(main_cells)
            if t:
                ys = [y for c in main_cells for y in (c["y0"], c["y1"])]
                main_elems.append({"text": t, "y_top": min(ys), "y_bot": max(ys), "label": lbl})

        if marg_cells:
            t = _dcells_text(marg_cells)
            if t and not _RE_INTEGER.match(t.strip()) and len(t.strip()) > 2:
                ys = [y for c in marg_cells for y in (c["y0"], c["y1"])]
                marg_elems.append({"text": t, "y_top": min(ys), "y_bot": max(ys)})

    return main_elems, marg_elems


def build_pdf_converter():
    """Create and return the docling DocumentConverter (call once, reuse)."""
    if not _PDF_AVAILABLE:
        raise RuntimeError("docling / pypdfium2 not installed; cannot extract PDFs")
    return _build_converter()


def run_docling_pass1(converter, pdf_path: str) -> dict:
    """
    Pass 1: run docling on a PDF and return docling_json (serialised clusters).
    Same format as the acts pipeline — can be stored and reused in pass 2.
    """
    if not _PDF_AVAILABLE:
        raise RuntimeError("docling / pypdfium2 not installed; cannot extract PDFs")
    path   = Path(pdf_path)
    result = converter.convert(str(path.resolve()))
    total  = len(pdfium.PdfDocument(str(path)))
    pages  = []
    for pg_idx in range(total):
        if pg_idx >= len(result.pages):
            break
        clusters = result.pages[pg_idx].predictions.layout.clusters
        ptype    = _detect_page_type(clusters)
        pages.append({
            "index":     pg_idx,
            "page_type": ptype,
            "clusters":  _serialize_clusters(clusters),
        })
    return {"total_pages": total, "pages": pages, "source_type": "pdf"}


def build_document_pdf(docling_json: dict) -> dict:
    """
    Pass 2: build structured statute doc from stored docling_json (no PDF needed).
    Uses global median gap centre for column split, same logic as the live path.
    Returns same shape as extract_statute() plus flags/stopped/schedules.
    """
    if not _PDF_AVAILABLE:
        raise RuntimeError("docling not available")
    from statistics import median

    pages_raw = docling_json.get("pages", [])

    # Recompute global gap from stored dict clusters
    gap_centers: list[float] = []
    for pg in pages_raw:
        body = [cl for cl in pg["clusters"]
                if cl["label"] not in ("page_header", "page_footer")]
        gap = _find_column_gap_d(body)
        if gap:
            gap_centers.append(gap[0])
    global_gap = median(gap_centers) if gap_centers else None

    _RE_PART_JOIN = re.compile(r'^(PART)([IVXLC][A-Z]*)', re.IGNORECASE)

    def fix_part(text: str) -> str:
        return _RE_PART_JOIN.sub(lambda m: f"{m.group(1)} {m.group(2)}", text)

    meta: dict = {}
    pages_data: list = []

    for pg in pages_raw:
        clusters_d = pg["clusters"]
        ptype      = pg.get("page_type") or _detect_page_type_d(clusters_d)

        if pg["index"] == 0:
            meta.update(_extract_cover_metadata_d(clusters_d))
            for cl in clusters_d:
                if cl.get("label") == "section_header":
                    t = _dcells_text(cl["cells"]).strip()
                    if t and len(t) < 100:
                        meta["title"] = t
                        break

        if ptype == "sparse":
            pages_data.append(([], []))
        elif global_gap is not None:
            pages_data.append(_page_elements_at_d(clusters_d, global_gap))
        else:
            pages_data.append(_page_elements_d(clusters_d))

    # Fix PARTI → PART I in element texts
    pages_data = [
        ([{**e, "text": fix_part(e["text"])} for e in main], marg)
        for main, marg in pages_data
    ]

    parts_raw, sections_raw, schedules_raw, appendices_raw, flags, stopped = \
        _build_structure(pages_data)

    parts = [
        {
            "number":   p["number"],
            "title":    p.get("title", ""),
            "sections": [str(s) for s in p.get("sections", [])],
            "type":     p.get("type", "part"),
        }
        for p in parts_raw
    ]
    sections = {
        num_str: {
            "short_title": s.get("short_title"),
            "part":        s.get("part"),
            "body":        s.get("body", []),   # structured nodes, not flat text
        }
        for num_str, s in sections_raw.items()
    }

    return {
        "title":        meta.get("title", ""),
        "description":  "",
        "enacted_date": meta.get("certified"),
        "is_repealed":  False,
        "parts":        parts,
        "sections":     sections,
        "schedules":    schedules_raw,
        "flags":        flags,
        "stopped":      stopped,
    }


def extract_statute_pdf(converter, pdf_path: str) -> dict:
    """
    Extract a consolidated statute from a PDF using docling.
    converter — from build_pdf_converter()
    Returns the same dict shape as extract_statute().
    """
    if not _PDF_AVAILABLE:
        raise RuntimeError("docling / pypdfium2 not installed; cannot extract PDFs")

    path = Path(pdf_path)
    result = converter.convert(str(path.resolve()))
    total_pages = len(pdfium.PdfDocument(str(path)))

    # Pass 1: collect per-page gap centres to compute a stable global split.
    # Consolidated PDFs have a consistent marginal column but stray cells
    # often bridge the gap on individual pages, causing per-page detection to
    # fail.  Using the median of successful detections gives a reliable split
    # that works across the whole document.
    from statistics import median
    gap_centers: list[float] = []
    for pg_idx in range(min(total_pages, len(result.pages))):
        clusters = result.pages[pg_idx].predictions.layout.clusters
        body = [cl for cl in clusters
                if cl.label.value not in ("page_header", "page_footer")]
        gap = _find_column_gap(body)
        if gap:
            gap_centers.append(gap[0])
    global_gap = median(gap_centers) if gap_centers else None

    meta: dict = {}
    pages_data: list = []

    for pg_idx in range(total_pages):
        if pg_idx >= len(result.pages):
            break
        clusters = result.pages[pg_idx].predictions.layout.clusters
        ptype = _detect_page_type(clusters)
        if pg_idx == 0:
            meta.update(_extract_cover_metadata(clusters))
            # Override title: the cover section_header is the short title;
            # extract_cover_metadata() often picks up amendment "Act Nos" text.
            for cl in clusters:
                if (hasattr(cl.label, "value") and cl.label.value == "section_header"):
                    t = _cells_text(cl.cells).strip()
                    if t and len(t) < 100:
                        meta["title"] = t
                        break
        if ptype == "sparse":
            pages_data.append(([], []))
        elif global_gap is not None:
            pages_data.append(_page_elements_at(clusters, global_gap))
        else:
            pages_data.append(_page_elements(clusters))

    # Normalise PART headings: PDF renderer drops the space between "PART" and
    # the Roman numeral (e.g. "PARTI" instead of "PART I", "PARTIA" for Part IA).
    _RE_PART_JOIN = re.compile(r'^(PART)([IVXLC][A-Z]*)', re.IGNORECASE)

    def _fix_part(text: str) -> str:
        return _RE_PART_JOIN.sub(lambda m: f"{m.group(1)} {m.group(2)}", text)

    pages_data = [
        ([{**e, "text": _fix_part(e["text"])} for e in main], marg)
        for main, marg in pages_data
    ]

    parts_raw, sections_raw, schedules_raw, _appendices, flags, stopped = \
        _build_structure(pages_data)

    parts = [
        {
            "number":   p["number"],
            "title":    p.get("title", ""),
            "sections": [str(s) for s in p.get("sections", [])],
            "type":     p.get("type", "part"),
        }
        for p in parts_raw
    ]
    sections = {
        num_str: {
            "short_title": s.get("short_title"),
            "part":        s.get("part"),
            "body":        _section_full_text(s),
        }
        for num_str, s in sections_raw.items()
    }

    return {
        "title":        meta.get("title", ""),
        "description":  "",
        "enacted_date": meta.get("certified"),
        "is_repealed":  False,
        "parts":        parts,
        "sections":     sections,
        "schedules":    schedules_raw,
        "flags":        flags,
        "stopped":      stopped,
    }
