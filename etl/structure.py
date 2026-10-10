#!/usr/bin/env python3
"""Step 3: raw extraction -> blocks -> structured Act. Cheap and repeatable; never edits raw.

  python3 -m etl.structure raw.json.gz [...] [--out DIR]   # local raw files (testing)

blocks(raw): the docling adapter. One block per layout cluster, split at the margin gap:
  {page, bbox [x0,y0,x1,y1] in PDF points (top-left origin), label, role, text}
  role: body | margin (marginal note) | furniture (running header, page number, back page)
  The margin gap is found per document and page parity (recto/verso), so page size
  (384x552, A4, 419x595) doesn't matter. Clusters that straddle it are split by cell.

act(blocks): front matter (title, certified date, long title, preamble), then sections
in order with their marginal note, Part/Chapter, and paragraphs; schedules after.
Quoted text (amending Acts: "substitution therefor of the following ... '3. ...'") is
fenced: it stays inside the section that quotes it and its numbers never open a section.

ponytail: docling only. Chandra raw (scans, pre-2000) needs its own adapter into the same
block shape; add when the scan extraction runs. Sinhala/Tamil legacy fonts (FM*, GPRasanji)
need font->Unicode first, so only English structures cleanly for now.
"""
import argparse, gzip, html, json, re, sys
from collections import Counter
from pathlib import Path

ORD = r'FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH'
PART = re.compile(r'^PART\s+([IVXL]+|\d+)\b\s*[-—–:.]?\s*(.*)$')
CHAPTER = re.compile(r'^CHAPTER\s+([IVXL]+|\d+)\b\s*[-—–:.]?\s*(.*)$')
SCHED = re.compile(rf'^((?:{ORD})\s+)?SCHEDULE\b(\s+[A-Z0-9]{{1,3}}\b)?', re.I)
SECTION = re.compile(r'^(\d{1,3}[A-Z]{0,2})\s*\.\s+(.*)$', re.S)
# a scan read without the dot, "11 (1) The Corporation shall ..." (30/2008); trusted only for the
# next number with its own marginal note
SECTION_NODOT = re.compile(r'^(\d{1,3}[A-Z]{0,2})\s+(\(1\)\s.*)$', re.S)
LABEL = re.compile(r'^(\((?:[a-z]{1,2}|[ivxl]+|\d{1,3}[A-Za-z]?)\))\s*(.*)$', re.S)
ENACTING = re.compile(r'^(?:NOW\s+)?(?:THEREFORE\s*,?\s*)?BE\s+it\s+(?:therefore\s+)?enacted', re.I)
CERTIFIED = re.compile(r'Certified\s+on\s+(.+?)\]?\s*$', re.I)
CITATION = re.compile(r'(?:Act|Ordinance|Law),?\s*No\.?\s*(\d+)\s+of\s+(\d{4})', re.I)
BACKPAGE = re.compile(r'PRAKASHANA|can be purchased|Annual subscription|^\d+-PL \d+', re.I)
QUOTES = "'‘’\"“”"
# "... repealed and the following section substituted therefor:-" -> the next block is quoted text,
# even when its opening quote mark went to the marginal note or was never printed (22/2017)
# a section that amends: "Section 89 of the principal enactment is hereby repealed ...", "The following new section ..."
AMEND = re.compile(r'^(?:\(1\)\s+)?(?:Section|Sections|The|Part|Chapter|Schedule|Paragraph)\b.{0,200}?\b(?:hereby|principal enactment)\b', re.S)
INTRO = re.compile(r'(?=.*\b(?:substitut|insert|addition|added|replac)\w*\b)(?=.*\bfollowing\b).*[:\-—–]\s*$', re.I | re.S)


def clean(t):
    # Surya's OCR keeps formatting as tags ("<b>Provisions</b>", "<i>", "<math>"); the raw stays verbatim
    t = re.sub(r'</?(?:b|i|u|em|strong|sup|sub|math|br|span)\b[^>]*>', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return re.sub(r'\(\s+([A-Za-z0-9]{1,4})\s+\)', r'(\1)', t)   # italic labels come out as "( a )"


def join(cells):
    out = ''
    for c in cells:
        t = c["text"].strip()
        # a hyphen at a line end is kept: in these Acts it is a compound ("non-governmental",
        # "sub-paragraph"), not a word split; measured on 65 Acts (docs/PIPELINE.md)
        out = out + t if out.endswith('-') and t[:1].islower() else (out + ' ' + t if out else t)
    return clean(out)


def top_y(cell):
    return min(cell["rect"]["r_y0"], cell["rect"]["r_y2"])


def cx(cell):
    r = cell["rect"]
    return (min(r["r_x0"], r["r_x2"]) + max(r["r_x0"], r["r_x2"])) / 2


SKIP = {"picture", "page_header", "page_footer", "table", "document_index"}


BODY_W = 240   # body column width in pt, the same in every format seen (LAYOUT.md): 39-278, 144-384, 131-374


def body_band(pages, min_margin=2, scan=False):
    """Body column of one page parity (recto/verso) -> (split x, margin side) or None.
    Justified body lines all end at the column's right edge R, so R is the commonest line end;
    the left edge is R - BODY_W. Measuring the left edge directly fails: short amending Acts have
    few full-width lines, and inserted sections bring indented text and their own quoted notes."""
    lines = []
    for p in pages:
        h = p["size"]["height"]
        for c in p["predictions"]["layout"]["clusters"]:
            if c["label"] not in SKIP and c["bbox"]["t"] >= 0.24 * h:
                lines += [(min(x["rect"]["r_x0"], x["rect"]["r_x2"]), max(x["rect"]["r_x0"], x["rect"]["r_x2"]))
                          for x in c["cells"]]
    if not lines:
        return None
    # only lines wider than a note can say where the body ends (one short page of body, 26/2018)
    R = Counter(round(r) for l, r in lines if r - l > 100).most_common(1)
    R = R[0][0] if R else Counter(round(r) for _, r in lines).most_common(1)[0][0]
    L = R - BODY_W
    if scan:
        # a scan's line ends scatter by a few pt (Chandra blocks: 443-445, 26/1981): R is the end most lines reach
        ends = [r for l, r in lines if r - l > 100] or [r for _, r in lines]
        R = max(ends, key=lambda e: sum(abs(r - e) <= 4 for r in ends))
        # a booklet page scanned onto A4 (pre-2000) scales the column to ~350 pt (51/1998): the body's
        # left edge is where the full lines ending at R start: the second-leftmost, since most may be
        # indented (definitions, 16/1995 p9) and one may be a note merged into its line.
        # Scans only: on digital pages wide lines ending at R are tables and headings (10/2015)
        starts = sorted(l for l, r in lines if abs(r - R) <= 6 and r - l > BODY_W + 20)
        if len(starts) >= 2:
            L = starts[1] if len(starts) > 2 else starts[0]
    left, right = sum(r < L - 3 for _, r in lines), sum(l > R + 3 for l, _ in lines)
    if max(left, right) < min_margin:      # 2 docling lines; 1 Chandra block (a note is one block)
        return None
    return ((L - 4, 'left') if left > right else (R + 4, 'right')) + (L,)


CHANDRA_LABEL = {"Text": "text", "Section-Header": "section_header", "List-Group": "list_item",
                 "Page-Header": "page_header", "Page-Footer": "page_footer", "Table": "table",
                 "Image": "picture", "Caption": "text", "Footnote": "footnote", "Form": "form",
                 "Table-Of-Contents": "document_index"}

LIGHTON_LABEL = {"text": "Text", "title": "Section-Header", "list": "List-Group", "header": "Page-Header",
         "footer": "Page-Footer", "page_number": "Page-Footer", "footnote": "Footnote", "caption": "Caption",
         "table": "Table", "image": "Image", "chart": "Image", "header_image": "Image",
         "footer_image": "Image", "aside_text": "Text", "formula": "Text", "code": "Text"}
LIGHTON_BLOCK = re.compile(r'^!\[([a-z_]+)\+?\]\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)[ \t]*', re.M)


def html_text(h):
    h = re.sub(r'<br\s*/?>', ' ', h)
    h = re.sub(r'<[^>]+>', '', h)
    return clean(h.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
                 .replace('&#39;', "'").replace('&nbsp;', ' '))


def _push_notes(clusters, tables):
    """A section opener and its note side by side: Chandra splits that line where the note's box
    starts, often inside the body column (40/1984: opener 50-292, note 302-505, body 50-426), so the
    note's centre falls in the body. Move each such note's box just outside the body column."""
    cl = [c for c in clusters if c["id"] not in tables and c["label"] not in SKIP]
    pairs = [(a, b) for a in cl for b in cl if a is not b and abs(a["bbox"]["t"] - b["bbox"]["t"]) < 8
             and (SECTION.match(a["cells"][0]["text"]) or SECTION_NODOT.match(a["cells"][0]["text"]))
             and not SECTION.match(b["cells"][0]["text"]) and len(b["cells"][0]["text"]) < 150
             and (a["bbox"]["r"] <= b["bbox"]["l"] + 15 or b["bbox"]["r"] <= a["bbox"]["l"] + 15
                  # ...or inside the opener's box, at its outer end (26/1992: opener 37-386, note 333-386)
                  or b["bbox"]["l"] > a["bbox"]["l"] + 0.6 * (a["bbox"]["r"] - a["bbox"]["l"])
                  or b["bbox"]["r"] < a["bbox"]["l"] + 0.4 * (a["bbox"]["r"] - a["bbox"]["l"]))]
    paired = {id(x) for p in pairs for x in p}
    rest = [c["bbox"] for c in cl if id(c) not in paired and c["bbox"]["r"] - c["bbox"]["l"] > 100]
    if not pairs or not rest:
        return

    def edge(vals):            # the edge most blocks reach, within 4 pt
        return max(vals, key=lambda e: sum(abs(v - e) <= 4 for v in vals))
    R, L = edge([b["r"] for b in rest]), edge([b["l"] for b in rest])
    for a, n in pairs:
        b, rect = n["bbox"], n["cells"][0]["rect"]
        if n["bbox"]["l"] > a["bbox"]["l"]:           # note on the right
            b["l"] = max(b["l"], R + 12)
            b["r"] = max(b["r"], b["l"] + 20)
        else:
            b["r"] = min(b["r"], L - 12)
            b["l"] = min(b["l"], b["r"] - 20)
        rect["r_x0"], rect["r_x2"] = b["l"], b["r"]


def lighton_html(md):
    """LightOnOCR-3 grounding output (`![label](x0,y0,x1,y1)` + markdown, 0-1000 grid; etl.ocr) -> Chandra's
    <div data-bbox data-label> blocks, so chandra_pages() reads LightOn pages too."""
    out, heads = [], list(LIGHTON_BLOCK.finditer(md))
    for i, m in enumerate(heads):
        body = md[m.end(): heads[i + 1].start() if i + 1 < len(heads) else len(md)].strip()
        label = LIGHTON_LABEL.get(m[1], "Text")
        if label == "Table" or body.lstrip().startswith("<table"):
            inner = body
            # the 4B often sets sections and their notes as two-cell rows ("<td>Amendment of section 73
            # ...</td><td>7. Section 73 ...</td>", 48/1984): a text block, so chandra_pages() reads each
            # row as paragraph + note (as with Chandra's tables inside text blocks), not as a data table
            rows = re.findall(r'<tr[^>]*>(.*?)</tr>', body, re.S)
            opens = sum(bool(re.search(r'<td[^>]*>\s*(?:\d{1,3}[A-Z]{0,2}\s*\.|\(\w{1,4}\))\s', r)) for r in rows)
            if rows and opens * 2 >= len(rows) and all(len(re.findall(r'<td', r)) <= 2 for r in rows):
                label = "Text"
        else:
            paras = []
            for p in re.split(r'\n\s*\n', body):
                p = p.strip()
                if not p:
                    continue
                tag = "h2" if p.startswith("#") else "li" if re.match(r'^[-*] ', p) else "p"
                # the 0.8B writes a section's marginal note in italics at the end of its block, the box
                # spanning body and margin ("... agreement”. *Amendment of section 7 of Chapter 203.*",
                # 8/1990): Chandra's float span, which chandra_pages() moves into the margin
                note = re.match(r'^(.{40,}?)\s+\*([A-Z][^*]{2,})\*?\s*$', p, re.S)
                float_ = ""
                if note:
                    p = note[1]
                    side = "right" if int(m[4]) > 1000 - int(m[2]) else "left"
                    float_ = f'<span style="float: {side};">{html.escape(note[2].strip(), quote=False)}</span>'
                p = re.sub(r'^(#+|[-*]) ', '', p)
                p = re.sub(r'^\s*>\s?|\s>\s*$', '', p, flags=re.M)        # quote markers
                p = re.sub(r'\*\*?([^*]+)\*\*?', r'\1', p).replace("\n", " ").strip(" *>")
                paras.append(f"<{tag}>{html.escape(p, quote=False)}{float_}</{tag}>")
            inner = "".join(paras)
        out.append(f'<div data-bbox="{m[2]} {m[3]} {m[4]} {m[5]}" data-label="{label}">{inner}</div>')
    return "\n".join(out)


def chandra_pages(raw):
    """Chandra's per-page HTML -> pages shaped like docling's (clusters of cells in PDF points), so
    blocks() handles scans, digital pages and mixed files alike. Each <div data-bbox data-label>
    is a block on a 0..bbox_scale grid of the page image. A block holding several paragraphs or
    list items becomes one cluster per paragraph, sharing the block's height in order; marginal
    notes are blocks of their own."""
    c = raw.get("chandra")
    # LightOnOCR-3 pages (raw/lighton, etl.ocr; 2026-10-09) replace Chandra's / Surya's where they ended
    # cleanly; pages cut off at max_tokens or not in English keep the old engine's
    lo = {p["page_no"]: lighton_html(p["md"]) for p in (raw.get("lighton") or {}).get("pages", []) if p["finish"] == "stop"}
    if lo:
        c = {"params": {"bbox_scale": 1000}, "pages": [p for p in (c or {}).get("pages", []) if p["page_no"] not in lo]
             + [{"page_no": n, "raw": h} for n, h in sorted(lo.items())]}
    if not c:
        return []
    scale = c["params"].get("bbox_scale", 1000)
    size = {p["page_no"]: (p["width_pt"], p["height_pt"]) for p in raw["pages"]}
    out = []
    for pg in c["pages"]:
        w, h = size[pg["page_no"]]
        clusters, tables = [], {}
        for m in re.finditer(r'<div[^>]*data-bbox="([\d.\s]+)"[^>]*data-label="([^"]+)"[^>]*>(.*?)</div>(?=\s*<div|\s*$)',
                             pg["raw"], re.S):
            x0, y0, x1, y1 = (float(v) for v in m[1].split())
            l, t, r, b = x0 * w / scale, y0 * h / scale, x1 * w / scale, y1 * h / scale
            label, inner = CHANDRA_LABEL.get(m[2], "text"), m[3]
            if label == "table":
                rows = [[html_text(cell) for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.S)]
                        for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', inner, re.S)]
                cid = len(clusters)
                cell = {"text": " ".join(" ".join(r_) for r_ in rows), "rect": {"r_x0": l, "r_y0": t, "r_x2": r, "r_y2": b}}
                clusters.append({"id": cid, "label": label, "bbox": {"l": l, "t": t, "r": r, "b": b}, "cells": [cell]})
                tables[cid] = {"num_rows": len(rows), "num_cols": max((len(r_) for r_ in rows), default=0),
                               "table_cells": [{"start_row_offset_idx": i, "start_col_offset_idx": j, "text": v}
                                               for i, r_ in enumerate(rows) for j, v in enumerate(r_)]}
                continue
            # a marginal note Chandra wrote inside the body block, <span style="float: right;">Short
            # title.</span> (32/2008): its own cluster in the margin, the body trimmed to the column
            floats = re.findall(r'<span[^>]*float:\s*(left|right)[^>]*>(.*?)</span>', inner, re.S)
            if floats:
                inner = re.sub(r'<span[^>]*float:\s*(?:left|right)[^>]*>.*?</span>', ' ', inner, flags=re.S)
                for side, note in floats:
                    nl, nr = (min(r, l + BODY_W) + 12, r) if side == "right" else (l, max(l, r - BODY_W) - 12)
                    nr = max(nr, nl + 20)
                    cell = {"text": html_text(note), "rect": {"r_x0": nl, "r_y0": t, "r_x2": nr, "r_y2": t + 10}}
                    clusters.append({"id": len(clusters), "label": "text",
                                     "bbox": {"l": nl, "t": t, "r": nr, "b": t + 10}, "cells": [cell]})
                if r - l > BODY_W + 20:
                    l, r = (l, l + BODY_W) if floats[0][0] == "right" else (r - BODY_W, r)
            # (text, note, side). Chandra sets a section opener and its note as a two-cell table row
            # inside a text block ("<tr><td>1. This Act may be cited ...</td><td>Short title.</td>",
            # 34/1987): the longer cell is the paragraph, the shorter its note, on its own side
            parts = []
            for m in re.finditer(r'<tr[^>]*>(.*?)</tr>|<(p|li|h\d)[^>]*>(.*?)</\2>', inner, re.S):
                if m[1] is None:
                    parts.append((html_text(m[3]), None, None))
                    continue
                if len(re.findall(r'<(?:p|li)\b', m[1])) > 2:   # a whole column per cell (3/1982): paragraph by paragraph
                    parts += [(html_text(x[1]), None, None) for x in re.findall(r'<(p|li|h\d)[^>]*>(.*?)</\1>', m[1], re.S)]
                    continue
                tds = [x for x in (html_text(x) for x in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', m[1], re.S)) if x]
                if (len(tds) == 2 and min(map(len, tds)) < 150 and max(map(len, tds)) > min(map(len, tds))
                        and len(re.findall(r'[A-Za-z]', min(tds, key=len))) >= 3):     # not a page number
                    i = 0 if len(tds[0]) > len(tds[1]) else 1
                    parts.append((tds[i], tds[1 - i], "right" if i == 0 else "left"))
                else:
                    parts += [(x, None, None) for x in tds]
            parts = [x for x in parts if x[0]] or [(html_text(inner), None, None)]
            for i, (text, note, side) in enumerate(parts):
                pt, pb = t + (b - t) * i / len(parts), t + (b - t) * (i + 1) / len(parts)
                pl, pr = l, r
                if note:            # the block spans paragraph and note: give each its share
                    cut = l + (0.8 if side == "right" else 0.2) * (r - l)
                    pl, pr = (l, cut) if side == "right" else (cut, r)
                    nl, nr = (cut + 12, r) if side == "right" else (l, cut - 12)
                    clusters.append({"id": len(clusters), "label": "text", "bbox": {"l": nl, "t": pt, "r": nr, "b": pt + 10},
                                     "cells": [{"text": note, "rect": {"r_x0": nl, "r_y0": pt, "r_x2": nr, "r_y2": pt + 10}}]})
                cell = {"text": text, "rect": {"r_x0": pl, "r_y0": pt, "r_x2": pr, "r_y2": pb}}
                clusters.append({"id": len(clusters), "label": label,
                                 "bbox": {"l": pl, "t": pt, "r": pr, "b": pb}, "cells": [cell]})
        _push_notes(clusters, tables)
        out.append({"page_no": pg["page_no"], "size": {"width": w, "height": h}, "parsed_page": True,
                    "predictions": {"layout": {"clusters": clusters}, "tablestructure": {"table_map": tables}}})
    return out


def html_rows(page):
    """An HTML Act (lankalaw.net) -> [(note, text)] in reading order. Every era lays a section out
    as one table row: a narrow first cell (80-100px) with the marginal note and a wide cell with the
    text, subsections nested as rows of the same shape. Other text (title, long title, headings)
    comes out with note None."""
    from html.parser import HTMLParser

    class Tree(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.root = {"tag": "root", "attrs": {}, "kids": []}
            self.stack = [self.root]

        def handle_starttag(self, tag, attrs):
            if tag in ("br", "meta", "img", "hr", "input", "link"):
                self.stack[-1]["kids"].append(" ")
                return
            node = {"tag": tag, "attrs": dict(attrs), "kids": []}
            self.stack[-1]["kids"].append(node)
            self.stack.append(node)

        def handle_startendtag(self, tag, attrs):
            self.stack[-1]["kids"].append({"tag": tag, "attrs": dict(attrs), "kids": []})

        def handle_endtag(self, tag):
            for i in range(len(self.stack) - 1, 0, -1):    # tolerate unclosed tags
                if self.stack[i]["tag"] == tag:
                    del self.stack[i:]
                    break

        def handle_data(self, data):
            self.stack[-1]["kids"].append(data)

    t = Tree()
    t.feed(page)
    out = []

    def own_text(n):                 # the node's text without nested tables
        return clean(" ".join(k if isinstance(k, str) else ("" if k["tag"] == "table" else own_text(k))
                              for k in n["kids"]))

    def tables(n):
        for k in n["kids"]:
            if isinstance(k, dict):
                if k["tag"] == "table":
                    yield k
                else:
                    yield from tables(k)

    def width(td):
        m = re.match(r"\s*(\d+)", td["attrs"].get("width") or "")
        return int(m[1]) if m and "%" not in (td["attrs"].get("width") or "") else None

    BLOCK = ("div", "p", "center", "blockquote", "h1", "h2", "h3", "h4", "li")

    def has_struct(n):               # a table or block element anywhere inside: descend, don't flatten
        return any(isinstance(g, dict) and (g["tag"] in BLOCK + ("table", "tr") or has_struct(g)) for g in n["kids"])

    def blocks_of(n):
        """A layout cell: one row per block element, so the title, long title, date and enacting
        formula don't run together (1962: "Revenue Protection AN ACT TO APPEAL ...")."""
        buf = []
        def flush():
            if (x := clean(" ".join(buf))):
                out.append((None, x))
            buf.clear()
        for k in n["kids"]:
            if isinstance(k, str):
                buf.append(k)
            elif k["tag"] in ("table", "tr"):
                flush()
                walk(k)
            elif k["tag"] in BLOCK or has_struct(k):
                flush()
                blocks_of(k)
            else:
                buf.append(own_text(k))
        flush()

    def walk(n):
        if isinstance(n, str) or n["tag"] in ("head", "script", "style"):
            return
        if n["tag"] == "tr":
            tds = [k for k in n["kids"] if isinstance(k, dict) and k["tag"] in ("td", "th")]
            if len(tds) >= 2 and (width(tds[0]) or 999) <= 120:
                note, text = own_text(tds[0]), own_text(tds[1])
                if note and note[0] in QUOTES:          # an inserted section's own note: part of the quote
                    note, text = None, note + " " + text
                elif note and not SECTION.match(text) and not re.fullmatch(r"\d{1,3}[A-Z]{0,2}\s*\.", text):
                    out.append((None, note))            # a subsection's note ("Cap. 235.", 1962): kept in place
                    note = None
                at = len(out)
                if note or text:
                    out.append((note or None, text))
                for tb in tables(tds[1]):
                    walk(tb)
                # "2." with its text in the nested row below ("(1) Any property ..."): one paragraph,
                # so the note stays level with the section's opener
                if re.fullmatch(r"\d{1,3}[A-Z]{0,2}\s*\.", text) and len(out) > at + 1:
                    out[at:at + 2] = [(out[at][0], text + " " + out[at + 1][1])]
                return
            for td in tds:                              # a layout row: each block in it, then its tables
                blocks_of(td)
            return
        if n["tag"] in ("body", "root", "html") or n["tag"] in BLOCK:
            blocks_of(n)
            return
        for k in n["kids"]:
            walk(k)

    walk(t.root)
    return [(nt, tx) for nt, tx in out if tx or nt]


def commonlii_rows(bundle):
    """A CommonLII numbered Act (etl/spiders/commonlii.py: its index, long title and one page per section,
    joined) -> [(note, text)] like html_rows(). A section page: <H3>Title - Sect 2</H3>, the marginal note as
    <p><b>Establishment of ...</b></p>, then "2." and its subsections in nested table cells. The title row
    "Transport Board Law (No. 19 of 1978)" is written "..., No. 19 of 1978" so CITATION finds it."""
    parts = re.split(r"<!-- page (\S+) -->", bundle)[1:]
    rows, title = [], None
    for name, page in zip(parts[::2], parts[1::2]):
        body = re.split(r"</H3>", page, maxsplit=1, flags=re.I)[-1]
        body = re.split(r"<BR>\s*<HR>", body, flags=re.I)[0]
        if title is None and (m := re.search(r"<TITLE>\s*(.*?)\s*(?:-\s*(?:Sect|Long Title|Schedule).*)?</TITLE>", page, re.I | re.S)):
            title = re.sub(r"\s*\(\s*(No\.?\s*\d+\s+of\s+\d{4})\s*\)", r", \1", clean(m[1]))
            rows.append((None, title))
        if name.lower() == "index.html":
            continue
        note = None
        if (m := re.match(r"\s*<p[^>]*>\s*<b>(.*?)</b>\s*</p>", body, re.I | re.S)):
            note, body = html_text(m[1]), body[m.end():]
        texts = [t for t in (html_text(x) for x in re.split(r"(?i)<tr[^>]*>|<p[^>]*>|<br\s*/?>|<blockquote[^>]*>", body)) if t]
        if len(texts) > 1 and re.fullmatch(r"\d{1,3}[A-Z]{0,2}\s*\.", texts[0]):    # "2." alone, then "(1) ..."
            texts = [texts[0] + " " + texts[1]] + texts[2:]
        for i, t in enumerate(texts):
            rows.append((note if i == 0 else None, t))
    return rows


def html_pages(raw):
    """html_rows() -> docling-shaped pages: the note in a left margin, the text in a 240 pt body
    column at the same height, so blocks() and everything after it work unchanged. Rows before
    the Act's name (first row) go on page 1 (title page), the rest from page 2. Rows are 16 pt apart,
    more than merge_margins' 9 pt, because an HTML note is already whole."""
    rows = commonlii_rows(raw["html"]) if raw["html"].startswith("<!-- commonlii") else html_rows(raw["html"])
    first = 1
    pages, y = [], 0
    def page(no):
        pages.append({"page_no": no, "size": {"width": 595.0, "height": 842.0}, "parsed_page": True,
                      "predictions": {"layout": {"clusters": []}, "tablestructure": {"table_map": {}}}})
        return 220.0
    y = page(1)
    for i, (note, text) in enumerate(rows):
        if (i == first and pages[-1]["page_no"] == 1) or y > 780:
            y = page(pages[-1]["page_no"] + 1)
        cl = pages[-1]["predictions"]["layout"]["clusters"]
        h = 12.0 * (1 + len(text) // 70)
        for l, r, txt in ((100.0, 160.0, note), (172.0, 412.0, text)):
            if txt:
                rect = {"r_x0": l, "r_y0": y, "r_x2": r, "r_y2": y + 10}
                cl.append({"id": len(cl), "label": "html", "bbox": {"l": l, "t": y, "r": r, "b": y + h},
                           "cells": [{"text": txt, "rect": rect}]})
        y += h + 16
    return pages


def _lines(ws):
    """Words (x0, y0, x1, y1, text) -> lines, top to bottom: a word joins the line whose middle it covers."""
    out = []
    for w in sorted(ws, key=lambda w: (w[1], w[0])):
        line = next((l for l in reversed(out[-3:]) if w[1] <= (l[1] + l[3]) / 2 <= w[3]), None)
        if line:
            line[:4] = [min(line[0], w[0]), min(line[1], w[1]), max(line[2], w[2]), max(line[3], w[3])]
            line[4].append(w)
        else:
            out.append([*w[:4], [w]])
    for l in out:
        l[4].sort(key=lambda w: w[0])
    return out


def _mode(vals):
    return Counter(round(v / 3) * 3 for v in vals).most_common(1)[0][0] if vals else None


PARA_START = re.compile(r'^(\d{1,3}[A-Z]{0,2}\s*\.\s|\((?:[a-z]{1,2}|[ivxl]+|\d{1,3}[A-Za-z]?)\)|Provided\b|PART\b|CHAPTER\b|'
                        rf'(?:(?:{ORD})\s+)?SCHEDULE\b)')


def le1980_blocks(raw):
    """1980 Revised Edition chapters (lankalaw.net le1980): OCR text re-typeset as text-only PDF, two
    body columns a page, each with its marginal notes on its outer side (left column: notes far left;
    right column: notes far right). docling's clusters run across both columns, so this works from word
    cells. The right column is placed below the left one (y + page height) so reading order and the
    note-to-opener alignment of the Act rules hold unchanged. Same block shape as blocks()."""
    out = []
    for p in sorted((raw.get("docling") or {}).get("pages", []), key=lambda p: p["page_no"]):
        pp = p.get("parsed_page") or {}
        cells = pp.get("word_cells") or pp.get("textline_cells") or []   # Surya pages: line cells
        W, H = p["size"]["width"], p["size"]["height"]
        ws = [(min(r["r_x0"], r["r_x2"]), min(r["r_y0"], r["r_y2"]), max(r["r_x0"], r["r_x2"]), max(r["r_y0"], r["r_y2"]),
               c["text"]) for c in cells if c["text"].strip() for r in [c["rect"]]]
        if not ws:
            continue
        # running header "[Cap. 8" / "COMMISSIONS OF INQUIRY", footer "1/118": top and bottom 8%
        # ...or down to 12% when the line carries "[Cap. 339" (headers sit lower on some scans)
        furn = [w for w in ws if w[3] < 0.08 * H or w[1] > 0.92 * H] + [
            w for l in _lines([w for w in ws if w[1] < 0.12 * H]) if l[3] < 0.12 * H
            and re.search(r'Cap\.?\s*\d', " ".join(x[4] for x in l[4])) for w in l[4]]
        ws = [w for w in ws if w not in furn]
        furn = list(dict.fromkeys(furn))
        for l in _lines(furn):
            out.append({"page": p["page_no"], "label": "le1980", "role": "furniture", "bbox": l[:4],
                        "text": join([{"text": w[4]} for w in l[4]])})
        # gutter: the x near the middle that the fewest words cross
        g = min(range(int(0.38 * W), int(0.62 * W), 2),
                key=lambda x: (sum(w[0] < x < w[2] for w in ws), abs(x - W / 2)))
        lines = _lines(ws)
        # page 1: the heading, long title and date run across both columns, down to s.1's "1."
        one = []
        if p["page_no"] == 1:
            one = [w for w in ws if re.fullmatch(r'1\s*\.', w[4].strip()) and w[0] < g] or \
                  [w for l in lines for w, nx in zip(l[4], l[4][1:]) if w[4].strip() == "1" and w[0] < g and nx[4][:1].isupper()]
        top = min((w[1] for w in one), default=-1) - 2
        full = [l for l in lines if l[3] <= top or (any(w[0] < g < w[2] for w in l[4]) and l[2] - l[0] > 0.5 * W)]
        rest = [w for l in lines if l not in full for w in l[4]]
        left, right = [w for w in rest if (w[0] + w[2]) / 2 < g], [w for w in rest if (w[0] + w[2]) / 2 >= g]

        def split(col, side):
            """The note/body boundary: the x the fewest words cross, with notes on its outer side.
            Not the body's own edge: section numbers hang out of the body into the gap (x 90-99 for
            a body starting at 82, cap 46). None if this column has no notes."""
            if len(col) < 10:
                return None
            lo, hi = min(w[0] for w in col), max(w[2] for w in col)
            span = range(int(lo) + 15, int(lo + 0.45 * (hi - lo))) if side == "left" else \
                   range(int(hi - 0.45 * (hi - lo)), int(hi) - 15)
            outer = (lambda x: [w for w in col if w[2] < x]) if side == "left" else (lambda x: [w for w in col if w[0] > x])
            best = min(span, key=lambda x: (sum(w[0] < x < w[2] for w in col), -len(outer(x))), default=None)
            if best is None or len(outer(best)) < 3 or sum(w[0] < best < w[2] for w in col) > 0.1 * len(_lines(col)):
                return None
            return best
        sl, sr = split(left, "left"), split(right, "right")
        zones = {"noteL": [w for w in left if sl and w[2] < sl], "colL": [w for w in left if not (sl and w[2] < sl)],
                 "colR": [w for w in right if not (sr and w[0] > sr)], "noteR": [w for w in right if sr and w[0] > sr]}
        # header words on the note side are the list of laws consolidated ("Acts Nos. 17 of 1948, ...")
        zones = {"laws": [w for l in full for w in l[4] if sl and w[2] < sl], **zones}
        zones["colL"] += [w for l in full for w in l[4] if not (sl and w[2] < sl)]
        for z, zw in zones.items():
            dy = H if z in ("colR", "noteR") else 0
            ls = _lines(zw)
            if z.startswith("note"):
                for l in ls:             # one block per note line; merge_margins joins a note's lines
                    out.append({"page": p["page_no"], "label": "le1980", "role": "margin",
                                "bbox": [l[0], l[1] + dy, l[2], l[3] + dy], "text": join([{"text": w[4]} for w in l[4]])})
                continue
            left_x, right_x = _mode([l[0] for l in ls]), _mode([l[2] for l in ls if l[2] - l[0] > 100])
            hs = sorted(l[3] - l[1] for l in ls)
            lh = hs[len(hs) // 2] if hs else 8
            paras = []
            if z == "laws" and ls:      # one block: "Acts Nos. 17 of 1948, 8 of 1950, ..."
                ls = [[min(l[0] for l in ls), ls[0][1], max(l[2] for l in ls), ls[-1][3], [w for l in ls for w in l[4]]]]
            for l in ls:
                t = join([{"text": w[4]} for w in l[4]])
                prev = paras[-1] if paras else None
                if (not prev or PARA_START.match(t) or l[1] - prev["y1"] > 0.8 * lh
                        or (right_x and prev["x1"] < right_x - 20)           # short last line ends a paragraph
                        or (len(t) < 60 and t.upper() == t and re.search('[A-Z]', t))
                        or (prev["text"].upper() == prev["text"] and len(prev["text"]) < 60)):
                    paras.append({"x0": l[0], "y0": l[1], "x1": l[2], "y1": l[3], "text": t, "xr": l[2]})
                else:
                    prev.update(x0=min(prev["x0"], l[0]), x1=l[2], y1=l[3], xr=max(prev["xr"], l[2]),
                                text=prev["text"] + t if prev["text"].endswith('-') and t[:1].islower()
                                else prev["text"] + ' ' + t)
            for q in list(paras):           # the date closes the long title's last line: its own block
                if z == "colL" and (m := re.match(r'^(.+?)\s*(\[[^\[\]]*\d{4}\.?\s*[\]}]?)$', q["text"])) and q["y1"] <= top + 2:
                    paras.insert(paras.index(q) + 1, {**q, "text": m[2]})
                    q["text"] = m[1]
            for q in paras:
                # footnote marks after a section number, "67.*+ Where ..." (Penal Code)
                t = re.sub(r'^(\d{1,3}[A-Z]{0,2})\s*\.\s*[*+†‡]+\s*', r'\1. ', clean(q["text"]))
                if p["page_no"] == 1 and z == "colL":
                    t = re.sub(r'^1\s+(?=[A-Z])', '1. ', t)    # s.1 with its dot lost to OCR ("1 This Law", cap 339)
                # footnotes ("* Section 58 repealed by section 3 of Ordinance No. 50 of ...") are amendment
                # history, not section text. ponytail: dropped as furniture; keep them if the graph wants them
                foot = re.match(r'^[*+†‡]', t) is not None
                out.append({"page": p["page_no"], "label": "le1980", "role": "furniture" if foot else "body",
                            "bbox": [q["x0"], q["y0"] + dy, q["xr"], q["y1"] + dy], "text": t,
                            **({"indent": round(q["x0"] - left_x)} if left_x is not None else {})})
    return out


def blocks(raw, le1980=False):
    if le1980:
        return le1980_blocks(raw)
    if raw.get("format") == "html":
        raw = {"docling": {"pages": html_pages(raw)}, "pages": []}
    d = raw.get("docling") or {"pages": []}
    scanned = chandra_pages(raw)                 # scan pages: Chandra's, not docling's empty ones
    done = {p["page_no"] for p in scanned}
    # pages with no text layer that docling OCR'd itself (docling-surya): also scans, each shifted its own way
    ocr = done | {p["page_no"] for p in raw.get("pages", []) if p.get("chars", 1) == 0}
    pages = sorted([p for p in d["pages"] if p["parsed_page"] and p["page_no"] not in done] + scanned,
                   key=lambda p: p["page_no"])
    if not pages:
        return []
    bands = {par: body_band([p for p in pages if p["page_no"] % 2 == par and p["page_no"] > 1])
             for par in (0, 1)}
    # running title: most common top-of-page text across pages, page numbers stripped
    def bare(t):
        return re.sub(r'^\d+\s+|\s+\d+$', '', clean(t)).lower()
    tops = Counter(bare(join(c["cells"])) for p in pages for c in p["predictions"]["layout"]["clusters"]
                   if c["cells"] and c["bbox"]["t"] < 0.24 * p["size"]["height"])
    running = {t for t, n in tops.items() if n >= max(2, len(pages) // 4) and len(t) > 3}
    out, sizes = [], {p["page_no"]: p["size"]["height"] for p in pages}
    for p in pages:
        h, band = p["size"]["height"], bands[p["page_no"] % 2]
        if p["page_no"] in ocr and p["page_no"] > 1:
            # a scanned page sits where the scanner put it (31/2008: body ends at 290 on p2, 356 on p3),
            # so it gets its own column; the shared one only if this page has too little text
            band = body_band([p], min_margin=1, scan=True) or band
        # a one-page file is a web page printed as one tall page (lankalaw, 48/1999): no cover, and its
        # column isn't 240 pt, so it is measured as on a scan
        single = len(pages) == 1
        if single:
            band = body_band([p], min_margin=1, scan=True)
        tables = {int(k): t for k, t in (p["predictions"].get("tablestructure") or {}).get("table_map", {}).items()}
        is_margin = None
        if band and (p["page_no"] > 1 or single):
            split, side, _ = band
            is_margin = (lambda x: x < split) if side == 'left' else (lambda x: x > split)
        # tops of margin-note lines: a body line level with one that starts "N." opens a section,
        # even inside a cluster docling grouped with other paragraphs (a "form" cluster, 31/2022)
        note_tops = [top_y(x) for c in p["predictions"]["layout"]["clusters"] if is_margin and c["label"] not in SKIP
                     for x in c["cells"] if is_margin(cx(x))]
        page_out = []
        for c in sorted(p["predictions"]["layout"]["clusters"], key=lambda c: (c["bbox"]["t"], c["bbox"]["l"])):
            if not c["cells"] and c["id"] not in tables:
                continue
            b = c["bbox"]
            text = join(c["cells"])
            top = b["t"] < 0.24 * h
            furniture = (c["label"] in ("page_header", "page_footer")
                         or (top and (text.isdigit() or bare(text) in running
                                      or (len(text) < 100 and CITATION.search(text) and not SECTION.match(text)
                                          and not re.match(r'an\s+act\b', text, re.I)
                                          and not re.search(r'may\s+be\s+cited', text))))   # s1 with its note (2/1987)
                         or BACKPAGE.search(text))
            base = {"page": p["page_no"], "label": c["label"]}
            if furniture:
                page_out.append({**base, "bbox": [b["l"], b["t"], b["r"], b["b"]], "role": "furniture", "text": text})
                continue
            if c["id"] in tables:
                t = tables[c["id"]]
                grid = [[""] * t["num_cols"] for _ in range(t["num_rows"])]
                for tc in t["table_cells"]:
                    grid[tc["start_row_offset_idx"]][tc["start_col_offset_idx"]] = clean(tc["text"])
                page_out.append({**base, "bbox": [b["l"], b["t"], b["r"], b["b"]], "role": "body", "text": text, "rows": grid})
                continue
            runs = [("body", c["cells"])]
            if is_margin and c["label"] not in SKIP:
                runs = [("margin", [x for x in c["cells"] if is_margin(cx(x))])]
                for x in c["cells"]:
                    if is_margin(cx(x)):
                        continue
                    if (runs[-1][0] == "margin" or re.match(r'\d{1,3}[A-Z]{0,2}\s*\.(\s|$)', x["text"].strip())
                            and any(abs(top_y(x) - t) < 4 for t in note_tops)):
                        runs.append(("body", []))
                    runs[-1][1].append(x)
            for role, cells in runs:
                if cells:
                    page_out.append({**base, "role": role, "_cells": cells})
        # docling sometimes puts a section number and the paragraph's 2nd line in one cluster and
        # the 1st line, level with the number, in another (6/2026 s25): one paragraph, so merge
        for b in page_out:
            if b["role"] == "body" and b.get("_cells") and re.match(r'\d{1,3}[A-Z]{0,2}\s*\.$', b["_cells"][0]["text"].strip()):
                y0, x0 = top_y(b["_cells"][0]), b["_cells"][0]["rect"]["r_x0"]
                for c in page_out:
                    if (c is not b and c["role"] == "body" and c.get("_cells") and abs(top_y(c["_cells"][0]) - y0) < 3
                            and c["_cells"][0]["rect"]["r_x0"] > x0 and top_y(b["_cells"][-1]) > y0 + 3):
                        b["_cells"] = sorted(b["_cells"] + c["_cells"], key=lambda x: (round(top_y(x)), x["rect"]["r_x0"]))
                        c["_cells"] = []
        for b in page_out:
            cells = b.pop("_cells", None)
            if cells is None:
                out.append(b)
            elif cells:
                xs = [v for x in cells for v in (x["rect"]["r_x0"], x["rect"]["r_x2"])]
                ys = [v for x in cells for v in (x["rect"]["r_y0"], x["rect"]["r_y2"])]
                # OCR reads s1's "1." as "I.", "l," (59/1993, 33/1995) or "11." (14/1987), or loses it (17/1998)
                text = re.sub(r'^(?:[Il]|[1Il]{2}(?=\s*[.,]\s+This\s+(?:Act|Law)\s+may\s+be\s+cited))\s*[.,]\s+(?=This\s+(?:Act|Law)\b)',
                              '1. ', join(cells))
                if p["page_no"] in ocr and b["role"] == "body":    # ...or as anything short ("a,", 16/1996)
                    text = re.sub(r'^(?:\S{1,2}\s*[.,]?\s+)?(?=This\s+(?:Act|Law)\s+may\s+be\s+cited\b)', '1. ', text)
                if b["role"] == "body":
                    # a number, a space and a comma for the dot ("10 , It shall be lawful", 49/1988)
                    text = re.sub(r'^(\d{1,3}[A-Z]?)\s+,\s+(?=[A-Z(“"‘])', r'\1. ', text)
                    # a marginal note run into its opener ("Term of office of members. 6. Subject to ...",
                    # 36/2008): the note becomes a margin block level with the opener
                    if (fm := re.match(r'^([A-Z][A-Za-z ,\'’()&-]{3,80}\.)\s+(\d{1,3}[A-Z]?\.\s+(?:\(1\)\s+)?[A-Z“"‘(].*)$', text, re.S)):
                        out.append({**b, "role": "margin", "bbox": [min(xs) - 60, min(ys), min(xs) - 10, min(ys) + 10],
                                    "text": fm[1]})
                        text = fm[2]
                out.append({**b, "bbox": [min(xs), min(ys), max(xs), max(ys)], "text": text,
                            **({"indent": round(min(xs) - band[2])} if band and b["role"] == "body" else {}),
                            **({"scan": True} if p["page_no"] in ocr else {})})
    # a running title printed over two lines (5/2009, 22/2022 back pages): each half is part of
    # the full title, but neither carries the citation the furniture test looks for
    titles = [clean(b["text"]).lower() for b in out if b["role"] == "furniture" and CITATION.search(b["text"])]
    for b in out:
        t = re.sub(r'^\d+\s+|\s+\d+$', '', clean(b["text"])).lower()      # page number on the same line
        if (b["role"] == "body" and len(t) > 8 and b["bbox"][1] < 0.24 * sizes[b["page"]]
                and any(t in x for x in titles)):
            b["role"] = "furniture"
    return out


def merge_margins(margins, body):
    """A note wrapped over several clusters is one note: join a fragment to the one above it
    when they nearly touch, unless the fragment is level with a section opener (its own note)."""
    def opens(m):
        return any(b["page"] == m["page"] and SECTION.match(b["text"]) and abs(b["bbox"][1] - m["bbox"][1]) < 5
                   for b in body)
    notes = []
    # in page order, top to bottom: a fragment can sit in an earlier docling cluster than the note's
    # first line ("24 of 2017" before "Amendment of section 150 of Act, No.", 2/2025)
    for b in sorted(margins, key=lambda m: (m["page"], m["bbox"][1])):
        n = notes[-1] if notes else None
        if n and n["page"] == b["page"] and b["bbox"][1] - n["bbox"][3] < 9 and not opens(b):
            n["text"] += ' ' + b["text"]
            n["bbox"] = [min(n["bbox"][0], b["bbox"][0]), n["bbox"][1], max(n["bbox"][2], b["bbox"][2]), b["bbox"][3]]
        else:
            notes.append(dict(b))
    return notes


def num_key(n):
    m = re.match(r'(\d+)([A-Z]*)', n)
    return int(m[1]), m[2]


# a defined term, "'bank' means", "'executive' when used with ...": a short quoted span, then
# lower-case prose. A real quote opener ("'Provided that, ...", "'3. (1) The ...") has no such span.
# a list of quoted terms opens no quotation either: '(a) “President”, “Presidential” or ...' (17/1982 s19,
# one item per block in LightOn's output; read as a quotation, it swallowed s20-s468)
TERM = re.compile(rf"^[{QUOTES}]{{1,2}}(?![\d(])[^{QUOTES}]{{0,60}}[^\s{QUOTES}]\s?[{QUOTES}]\s*(?:\([^)]*\)\s*)?(?:[a-z]|,\s*[{QUOTES}])")


def quote_delta(text, open_):
    """Is a quote open after this block? Opens on a leading quote mark; closes on a quote
    mark followed only by ;.,:)- and spaces at the end. Inline 'terms' don't open."""
    t = text.strip()
    if not open_ and LABEL.match(t):
        t = LABEL.match(t)[2]
    opens = open_ or (t[:1] in QUOTES and not TERM.match(t))
    # closes on a quote mark followed only by punctuation at the end, or by ". or "; mid-block
    # (a closing "'." with a table column after it, 8/2014)
    if opens and (re.search(rf'[{QUOTES}]\s*[;.,:)—–-]*\s*$', t) or re.search(rf'.[{QUOTES}]\s*[.;](?:\s|$)', t)) \
            and (open_ or len(t) > 2):
        # a block that both starts and ends with a quote is self-contained, e.g. "'x' means y;'"
        return False
    return opens


KINDS = ("front", "section_start", "section_text", "quoted", "part_heading", "chapter_heading",
         "heading_title", "schedule_heading", "schedule_text", "furniture")


def rule_kinds(bs):
    """The rules' label for every body block (index in bs -> one of KINDS), plus warnings.
    Same label set as the Jev labeller (etl/label.py), so both feed assemble() and can be compared."""
    body = [(k, b) for k, b in enumerate(bs) if b["role"] == "body"]
    notes = merge_margins([b for b in bs if b["role"] == "margin"], [b for _, b in body])
    kinds, warnings = {}, []
    le = any(b["label"] == "le1980" for _, b in body)     # a 1980 Revised Edition chapter
    # a note is level with its opener within 4 pt; OCR boxes on a scan sit up to 7 pt apart (26/1996 s12)
    level = lambda b: 8 if b.get("scan") else 4

    # front matter: everything up to the enacting formula (or the first "1." if there is none)
    i = next((j for j, (_, b) in enumerate(body) if ENACTING.match(b["text"])), None)
    if i is None:
        # 1980 Revised Edition chapters print no enacting formula, and s.1 is on page 1
        i = next((j for j, (_, b) in enumerate(body) if (b["page"] > 1 or le) and re.match(r'^1\s*\.\s', b["text"])), 0)
        if not le:
            warnings.append("no enacting formula")
    else:
        i += 1
    enacted = i > 0 and bool(ENACTING.match(body[i - 1][1]["text"]))
    for k, _ in body[:i]:
        kinds[k] = "front"

    last, in_sched, quote, titled = None, False, False, False
    prev_text, prev_quoted = None, False      # the section's last paragraph, for the amending formula
    carry = None          # a section number docling put in a cluster of its own ("23.", 5/2015)
    for j, (k, b) in enumerate(body[i:]):
        t = b["text"]
        if last is not None and ENACTING.match(t) and enacted and b["page"] <= body[i - 1][1]["page"] + 1:
            # the first page scanned twice (51/1998: p3 = p2): drop the first copy, start again here
            warnings.append(f"p{body[i - 1][1]['page']} repeats on p{b['page']}; the first copy is dropped")
            for k2, _ in body[i:i + j + 1]:
                kinds[k2] = "furniture"
            last, in_sched, quote, titled, prev_text, prev_quoted, carry = None, False, False, False, None, False, None
            continue
        if last is not None and ENACTING.match(t):          # the PDF holds the Act twice (1/2010)
            warnings.append(f"Act text repeats from p{b['page']}; the repeat is dropped")
            for k2, _ in body[i + j:]:
                kinds[k2] = "furniture"
            break
        if carry is not None:
            t = bs[carry]["text"] + ' ' + t
        if re.fullmatch(r'\d{1,3}[A-Z]{0,2}\s*\.', t):
            carry = k
            continue
        pair, carry = [k] + ([carry] if carry is not None else []), None

        def put(kind):
            for j in pair:
                kinds[j] = kind
        # "SCHEDULE (Section 2)" isn't all caps (29/2018), so the heading word alone decides
        # ...or a table that starts with its heading ("SCHEDULE I section 2 54 or above ...", 28/2021)
        if not quote and (len(t) < 80 or "rows" in b) and re.match(rf'((?:{ORD})\s+)?SCHEDULE\b', t):
            in_sched = True
            put("schedule_heading")
            continue
        if b["label"] == "section_header" or (len(t) < 80 and t.upper() == t and not quote):
            if SCHED.match(t) and not quote:
                in_sched = True
                put("schedule_heading")
                continue
            if not in_sched and not quote:
                if PART.match(t) or CHAPTER.match(t):
                    put("part_heading" if PART.match(t) else "chapter_heading")
                    titled = not (PART.match(t) or CHAPTER.match(t))[2]
                    continue
                if titled and not SECTION.match(t):
                    put("heading_title")
                    titled = False
                    continue
        titled = False
        if in_sched and le and (ms := SECTION.match(t)) and num_key(ms[1]) == ((last or (0, ''))[0] + 1, '') and any(
                x["page"] == b["page"] and abs(x["bbox"][1] - b["bbox"][1]) < level(b) for x in notes):
            in_sched = False           # 1980 chapters print schedules between sections too (Monetary Law, cap 323)
        if in_sched:
            put("schedule_text")
            continue
        if not quote and prev_text and not prev_quoted and INTRO.search(prev_text) and not le:
            quote = True
        m = SECTION.match(t)
        n = m and num_key(m[1])
        prev = last or (0, '')
        if not m and (m2 := SECTION_NODOT.match(t)) and num_key(m2[1]) == (prev[0] + 1, '') and any(
                x["page"] == b["page"] and abs(x["bbox"][1] - b["bbox"][1]) < level(b) for x in notes):
            m, n = m2, num_key(m2[1])
        # an unclosed quote (closing mark never printed, 31/2022) ends at the next section number
        # level with an unquoted marginal note; inserted sections' notes start with a quote mark
        noted = any(x["page"] == b["page"] and abs(x["bbox"][1] - b["bbox"][1]) < level(b) and (le or x["text"][:1] not in QUOTES)
                    for x in notes)
        # ...or whose text is an amending formula ("48. Section 89 of the principal enactment is hereby
        # repealed", 83/1988): the note beside it may sit a little off level on a scan
        amend = bool(m and not le and AMEND.match(m[2]))
        if quote and m and n == (prev[0] + 1, '') and (noted or amend):
            quote = False
            warnings.append(f"unclosed quote ended at section {m[1]}")
        # the next number; a lettered one (12A) only right after its base (12); a jump (up to 10)
        # only with its own marginal note: numbered items of an inserted schedule have none (8/2012)
        # one number skipped (lost by OCR: 16/1996 s11 after s9), or a file starting mid-Act (59/1998 opens at
        # s5), only for text that reads as an opener: an amending formula or "(1) ..."
        opener = amend or bool(m and m[2].startswith("(1) "))
        if m and not quote and n > prev and (n[0] == prev[0] if n[1] else
                                             n[0] == prev[0] + 1 or (noted and n[0] <= prev[0] + (60 if le else 10))
                                             or (opener and not le and (n[0] == prev[0] + 2 or (last is None and n[0] <= 10)))):
            last = n
            put("section_start")
            t = m[2]
        elif last is None:
            put("front")
            continue
        # 1980 Revised Edition: consolidated, so no amending text to fence; and its OCR'd straight
        # quotes (" Wrongful loss", Penal Code) can't tell an opening mark from a closing one
        qd = quote_delta(t, quote) and not le
        lm = LABEL.match(t)
        quoted = not le and (quote or t.lstrip()[:1] in QUOTES or bool(lm and lm[2][:1] in QUOTES))
        if kinds.get(k) != "section_start":
            put("quoted" if quoted else "section_text")
        prev_text, prev_quoted = t, quoted
        quote = qd
    if quote:
        warnings.append("a quote was still open at the end")
    return kinds, warnings


def assemble(bs, kinds, warnings=(), cont=None):
    """Blocks + one label per body block -> the Act. Code, not the labeller, parses numbers,
    splits paragraph labels and attaches marginal notes. cont: the block indices that continue
    the previous block's sentence (from the labeller); None = guess from case and punctuation."""
    body = [(k, b) for k, b in enumerate(bs) if b["role"] == "body"]
    notes = merge_margins([b for b in bs if b["role"] == "margin"], [b for _, b in body])
    doc = {"title": None, "number": None, "year": None, "certified": None, "long_title": None,
           "preamble": [], "enacting": None, "front": [], "sections": [], "schedules": [], "warnings": list(warnings)}
    part = chapter = sec = sched = titled = heading = outer = None
    prev_p1, carry = None, ''
    single = max((b["page"] for _, b in body), default=1) == 1
    for k, b in body:
        kind, t = kinds.get(k, "section_text"), b["text"]
        if kind == "furniture":
            continue
        if kind == "front":
            if b["page"] == 1 and not (b["label"] == "le1980" and doc["title"]):   # 1980 chapters: no cover page
                if not doc["title"] and b["label"] == "le1980" and prev_p1 and re.fullmatch(r'CHAPTER\s*\d+[A-Z]?', prev_p1):
                    doc["title"] = t                 # 1980 Revised Edition: "CHAPTER 8" / "COMMISSIONS OF INQUIRY"
                    doc["cap"] = re.sub(r'^CHAPTER\s*', '', prev_p1)
                if not doc["title"] and b["label"] != "le1980" and CITATION.search(t) and ' ACT' in (' ' + t.upper()):
                    doc["title"] = prev_p1 + ' ' + t if t.upper().startswith('ACT') and prev_p1 else t   # wrapped (22/2022)
                    m = CITATION.search(t)
                    doc["number"], doc["year"] = int(m[1]), int(m[2])
                if not doc["certified"] and CERTIFIED.search(t):
                    doc["certified"] = CERTIFIED.search(t)[1].strip(' ]')
                prev_p1 = t
                # a one-page file has no cover: its long title and enacting formula are on page 1 (48/1999)
                if not single or doc["title"] == t or CERTIFIED.search(t):
                    continue
            if CERTIFIED.search(t):
                doc["certified"] = doc["certified"] or CERTIFIED.search(t)[1].strip(' ]')
            elif re.fullmatch(r"\[\s*(\d{1,2}\s*(?:st|nd|rd|th)?\s+[A-Za-z]+\s*[,.]?\s*\d{4})\s*\.?\s*[\]}]", t):
                # "[ 17th December , 1988 ]", the "th" a <sup>
                doc["certified"] = doc["certified"] or re.sub(r"(\d)\s+(st|nd|rd|th)\b", r"\1\2",
                                                              re.sub(r"\s+,", ",", t.strip("[] ")))
            elif re.match(r'^(?:AN\s+(?:ACT|ORDINANCE)|A\s+(?:LAW|PROCLAMATION))\b', t):
                doc["long_title"] = t
            elif ENACTING.match(t):
                doc["enacting"] = t
            elif re.match(r'^(AND\s+)?WHEREAS\b', t, re.I) or doc["preamble"]:
                doc["preamble"].append(t)
            else:
                doc["front"].append(t)
            continue
        if kind in ("part_heading", "chapter_heading"):
            m = (PART if kind == "part_heading" else CHAPTER).match(t)
            h = titled = {"num": m[1] if m else t, "title": (m[2] if m else None) or None}
            heading = None
            # whichever comes first is the outer level: Parts hold Chapters in 9/2023, Chapters
            # hold Parts in 5/2015; a new outer heading clears the inner one
            outer = outer or kind
            if kind == "part_heading":
                part, chapter = h, (None if outer == kind else chapter)
            else:
                chapter, part = h, (None if outer == kind else part)
            continue
        if kind == "heading_title":
            if titled and not titled["title"]:
                titled["title"] = t
            else:
                heading = t               # a cross-heading over the sections after it
            continue
        titled = None
        if kind == "schedule_heading":
            hm = SCHED.match(t) if "rows" in b else None   # heading and table in one block: split them
            sched = {"heading": hm[0].strip() if hm else t, "page": b["page"],
                     "paras": [{"text": t, "page": b["page"], "rows": b["rows"]}] if hm else []}
            doc["schedules"].append(sched)
            continue
        if kind == "schedule_text":
            if sched is None:
                sched = {"heading": None, "page": b["page"], "paras": []}
                doc["schedules"].append(sched)
            sched["paras"].append({"text": t, "page": b["page"], **({"rows": b["rows"]} if "rows" in b else {})})
            continue
        if kind == "section_start":
            if re.fullmatch(r'\d{1,3}[A-Z]{0,2}\s*\.', t):      # bare number, text in the next block
                carry = t + ' '
                continue
            m = SECTION.match(carry + t) or SECTION_NODOT.match(carry + t)
            carry = ''
            if m:
                sec = {"num": m[1], "note": None, "part": part, "chapter": chapter, **({"heading": heading} if heading else {}),
                       "pages": [b["page"], b["page"]], "paras": [], "_opener": b}
                doc["sections"].append(sec)
                t = m[2]
            else:
                doc["warnings"].append(f"labelled section start without a number, p{b['page']}: {t[:50]}")
        if sec is None:
            doc["front"].append(t)
            continue
        sec["pages"][1] = b["page"]
        quoted = kind == "quoted"
        lm = LABEL.match(t)
        if lm and LABEL.match(lm[2]):         # "(1) (a) The ..." -> "(1)" then "(a) The ..."
            sec["paras"].append({"label": lm[1], "text": "", "page": b["page"], **({"quoted": True} if quoted else {})})
            t, lm = lm[2], LABEL.match(lm[2])
        para = {"label": lm[1] if lm else None, "text": lm[2] if lm else t, "page": b["page"]}
        if quoted:
            para["quoted"] = True
        para["_b"] = b                        # for notes on inserted sections and defined terms, below
        if "rows" in b:
            para["rows"] = b["rows"]
        prev = sec["paras"][-1] if sec["paras"] else None
        # a paragraph broken across a page (or a cluster) continues without a label
        joins = (k in cont) if cont is not None else (t[:1].islower() and prev and prev["text"][-1:] not in '.;:—')
        if (prev and not para["label"] and joins and prev.get("quoted") == para.get("quoted")):
            prev["text"] += ' ' + para["text"]
        elif t:
            sec["paras"].append(para)

    # marginal notes: the note y-aligned with a section's opener; leftovers stay listed
    openers = {id(s["_opener"]): s for s in doc["sections"]}
    first = doc["sections"] and (doc["sections"][0]["_opener"]["page"], doc["sections"][0]["_opener"]["bbox"][1])
    dropped = {b["page"] for _, b in body} - {b["page"] for k, b in body if kinds.get(k) != "furniture"}
    paras = [p for s in doc["sections"] for p in s["paras"] if "_b" in p]
    quoted_paras = [p for p in paras if p.get("quoted")]
    for n in notes:
        if n["page"] in dropped:                 # e.g. the repeated copy of the Act (1/2010)
            continue
        # an inserted section's note opens with a quote mark ("“Service of notice." beside "9A. Any
        # notice ...", 83/1988): it goes on the quoted paragraph level with it or just above (80 pt),
        # not on an opener. Unattached, every such note was "not in the output verbatim".
        hit = [b for _, b in body if b["page"] == n["page"] and b["bbox"][1] <= n["bbox"][3] and n["bbox"][1] <= b["bbox"][3]]
        s = next((openers[id(b)] for b in hit if id(b) in openers), None)
        if s and not s["note"]:      # level with an opener: its note, even with a stray quote mark ("‘Short title.")
            s["note"] = n["text"]
            continue
        if n["text"][:1] in QUOTES:
            near = [p for p in quoted_paras if p["_b"]["page"] == n["page"] and "notes" not in p
                    and p["_b"]["bbox"][1] - 4 <= n["bbox"][3] and n["bbox"][1] - p["_b"]["bbox"][1] < 80]
            # ...or a defined term's own note, in quotes beside its definition (1980 chapters: cap 26 s2 has
            # one per term, '" Attorney- General. "'), which is not quoted text: the paragraph level with it,
            # which may hold many definitions and so many notes
            near = near or [p for p in paras if p["_b"]["page"] == n["page"]
                            and p["_b"]["bbox"][1] - 4 <= n["bbox"][3] and n["bbox"][1] <= p["_b"]["bbox"][3]]
            if near:
                max(near, key=lambda p: p["_b"]["bbox"][1]).setdefault("notes", []).append(n["text"])
                continue
        if not s:
            # a note set a little below its opener line (19/2023 s31): the nearest opener above it on
            # the page that has no note yet, within 80 pt
            above = [o for o in openers.values() if o["_opener"]["page"] == n["page"] and not o["note"]
                     and 0 <= n["bbox"][1] - o["_opener"]["bbox"][1] < 80]
            s = max(above, key=lambda o: o["_opener"]["bbox"][1], default=None)
        # ...and one printed without the quote mark (14/1993): level with a quoted paragraph, no opener near
        # (1980 chapters: any paragraph, as they are consolidated: definitions' notes without quotes, "Fiscal.")
        le = n.get("label") == "le1980"
        level = [p for p in (paras if le else quoted_paras) if p["_b"]["page"] == n["page"] and (le or "notes" not in p)
                 and p["_b"]["bbox"][1] - 4 <= n["bbox"][3] and n["bbox"][1] <= p["_b"]["bbox"][3]]
        if s and not s["note"]:
            s["note"] = n["text"]
        elif not s and level:
            min(level, key=lambda p: abs(p["_b"]["bbox"][1] - n["bbox"][1])).setdefault("notes", []).append(n["text"])
        elif first and (n["page"], n["bbox"][1]) < first:
            doc["front"].append(n["text"])          # e.g. "Preamble"
        else:
            doc["warnings"].append(f"margin note not on a section opener, p{n['page']}: {n['text'][:60]}")
    for s in doc["sections"]:
        del s["_opener"]
    for p in paras:
        del p["_b"]

    if doc["title"] and re.match(r'APPROPRIATION\s+ACT', doc["title"], re.I):   # amendments to one are fine
        # the budget tables' cells sit in the margin column: one count, not one warning each (2,239 on 2026-10-09)
        stray = [w for w in doc["warnings"] if w.startswith("margin note not on a section opener")]
        doc["warnings"] = [w for w in doc["warnings"] if w not in stray] + (
            [f"{len(stray)} margin texts not on a section opener (budget tables)"] if stray else [])
        doc["warnings"].insert(0, "Appropriation Act: budget-table layout (LAYOUT.md), not structured reliably")
    nums = [num_key(s["num"])[0] for s in doc["sections"]]
    gaps = sorted(set(range(1, max(nums, default=0) + 1)) - set(nums))
    if gaps:
        doc["warnings"].append(f"section numbers missing: {gaps[:20]}")
    if not doc["title"] and prev_p1 and any(b["label"] == "html" for _, b in body):
        doc["title"] = prev_p1                # an HTML Act names itself without "Act, No. N of YYYY"
    if (bare := [s["num"] for s in doc["sections"] if not s["note"]]):
        doc["warnings"].append(f"sections without a marginal note: {bare[:20]}")
    return doc


def lost_text(bs, doc):
    """Blocks (pages > 1, not furniture) whose text is not in the output verbatim, after removing
    what the output stores as structure (section number, paragraph labels, Part/Chapter lines)."""
    strings = []
    def walk(x):
        if isinstance(x, str):
            strings.append(x)
        elif isinstance(x, (dict, list)):
            for v in (x.values() if isinstance(x, dict) else x):
                walk(v)
    walk({k: v for k, v in doc.items() if k != "warnings"})     # warnings quote text too
    hay = clean(" ".join(strings))
    lost = []
    for b in bs:
        t = clean(b["text"])
        if (b["role"] == "furniture" or b["page"] == 1 or CERTIFIED.search(t) or PART.match(t) or CHAPTER.match(t)
                or re.fullmatch(r"\[[\s\d]+(?:st|nd|rd|th)?\s+[A-Za-z]+\s*,?\s*\d{4}\s*\]", t)):   # date line, stored as a date
            continue
        if (m := SECTION.match(t) or SECTION_NODOT.match(t)):
            t = m[2]
        while (m := LABEL.match(t)):
            t = m[2]
        if t and t[:80] not in hay:
            lost.append(b)
    return lost


def script(bs):
    """'english' unless most letters are Tamil or Sinhala: some files listed as English are not
    (17/1990 is Tamil, 6/1987 Sinhala, found 2026-10-06 once Surya read them)."""
    text = " ".join(b["text"] for b in bs if b["role"] == "body")
    latin = len(re.findall(r'[A-Za-z]', text))
    tamil = len(re.findall(r'[\u0B80-\u0BFF]', text))
    sinhala = len(re.findall(r'[\u0D80-\u0DFF]', text))
    return max((("english", latin), ("tamil", tamil), ("sinhala", sinhala)), key=lambda x: x[1])[0]


def act(bs):
    doc = assemble(bs, *rule_kinds(bs))
    if (lang := script(bs)) != "english":
        doc["warnings"].insert(0, f"not English: the text is {lang}")
    if (lost := lost_text(bs, doc)):
        doc["warnings"].insert(0, f"{len(lost)} blocks not in the output verbatim, first p{lost[0]['page']}: "
                               f"{lost[0]['text'][:60]}")
    return doc


def main():
    a = argparse.ArgumentParser()
    a.add_argument("raw", nargs="+", help="raw/v2 .json.gz files")
    a.add_argument("--out", default=".", help="directory for <name>.act.json and <name>.blocks.json")
    args = a.parse_args()
    for f in args.raw:
        raw = json.load(gzip.open(f))
        bs = blocks(raw)
        doc = {"sha256": raw["sha256"], "raw_version": raw["version"], **act(bs)}
        name = Path(f).name.split('.')[0]
        Path(args.out, f"{name}.blocks.json").write_text(json.dumps(bs, ensure_ascii=False, indent=1))
        Path(args.out, f"{name}.act.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        noted = sum(1 for s in doc["sections"] if s["note"])
        print(f"{name}: {doc['title']!r} | {len(doc['sections'])} sections ({noted} with note), "
              f"{len(doc['schedules'])} schedules, {len(doc['warnings'])} warnings", file=sys.stderr)
        for w in doc["warnings"][:8]:
            print("   ", w, file=sys.stderr)


if __name__ == "__main__":
    main()
