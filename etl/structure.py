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
import argparse, gzip, json, re, sys
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


def body_band(pages, min_margin=2):
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
    left, right = sum(r < L - 3 for _, r in lines), sum(l > R + 3 for l, _ in lines)
    if max(left, right) < min_margin:      # 2 docling lines; 1 Chandra block (a note is one block)
        return None
    return ((L - 4, 'left') if left > right else (R + 4, 'right')) + (L,)


CHANDRA_LABEL = {"Text": "text", "Section-Header": "section_header", "List-Group": "list_item",
                 "Page-Header": "page_header", "Page-Footer": "page_footer", "Table": "table",
                 "Image": "picture", "Caption": "text", "Footnote": "footnote", "Form": "form"}


def html_text(h):
    h = re.sub(r'<br\s*/?>', ' ', h)
    h = re.sub(r'<[^>]+>', '', h)
    return clean(h.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
                 .replace('&#39;', "'").replace('&nbsp;', ' '))


def chandra_pages(raw):
    """Chandra's per-page HTML -> pages shaped like docling's (clusters of cells in PDF points), so
    blocks() handles scans, digital pages and mixed files alike. Each <div data-bbox data-label>
    is a block on a 0..bbox_scale grid of the page image. A block holding several paragraphs or
    list items becomes one cluster per paragraph, sharing the block's height in order; marginal
    notes are blocks of their own."""
    c = raw.get("chandra")
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
            parts = [html_text(x) for x in re.findall(r'<(?:p|li|h\d)[^>]*>(.*?)</(?:p|li|h\d)>', inner, re.S)] \
                or [html_text(inner)]
            parts = [x for x in parts if x]
            for i, text in enumerate(parts):
                pt, pb = t + (b - t) * i / len(parts), t + (b - t) * (i + 1) / len(parts)
                cell = {"text": text, "rect": {"r_x0": l, "r_y0": pt, "r_x2": r, "r_y2": pb}}
                clusters.append({"id": len(clusters), "label": label,
                                 "bbox": {"l": l, "t": pt, "r": r, "b": pb}, "cells": [cell]})
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


def html_pages(raw):
    """html_rows() -> docling-shaped pages: the note in a left margin, the text in a 240 pt body
    column at the same height, so blocks() and everything after it work unchanged. Rows before
    the Act's name (first row) go on page 1 (title page), the rest from page 2. Rows are 16 pt apart,
    more than merge_margins' 9 pt, because an HTML note is already whole."""
    rows = html_rows(raw["html"])
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


def blocks(raw):
    if raw.get("format") == "html":
        raw = {"docling": {"pages": html_pages(raw)}, "pages": []}
    d = raw.get("docling") or {"pages": []}
    scanned = chandra_pages(raw)                 # scan pages: Chandra's, not docling's empty ones
    done = {p["page_no"] for p in scanned}
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
        if p["page_no"] in done and p["page_no"] > 1:
            # a scanned page sits where the scanner put it (31/2008: body ends at 290 on p2, 356 on p3),
            # so it gets its own column; the shared one only if this page has too little text
            band = body_band([p], min_margin=1) or band
        tables = {int(k): t for k, t in (p["predictions"].get("tablestructure") or {}).get("table_map", {}).items()}
        is_margin = None
        if band and p["page_no"] > 1:
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
                                          and not re.match(r'an\s+act\b', text, re.I))))
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
                out.append({**b, "bbox": [min(xs), min(ys), max(xs), max(ys)], "text": join(cells),
                            **({"indent": round(min(xs) - band[2])} if band and b["role"] == "body" else {})})
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
TERM = re.compile(rf"^[{QUOTES}]{{1,2}}(?![\d(])[^{QUOTES}]{{0,60}}[^\s{QUOTES}]\s?[{QUOTES}]\s*(?:\([^)]*\)\s*)?[a-z]")


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

    # front matter: everything up to the enacting formula (or the first "1." if there is none)
    i = next((j for j, (_, b) in enumerate(body) if ENACTING.match(b["text"])), None)
    if i is None:
        i = next((j for j, (_, b) in enumerate(body) if b["page"] > 1 and re.match(r'^1\s*\.\s', b["text"])), 0)
        warnings.append("no enacting formula")
    else:
        i += 1
    for k, _ in body[:i]:
        kinds[k] = "front"

    last, in_sched, quote, titled = None, False, False, False
    prev_text, prev_quoted = None, False      # the section's last paragraph, for the amending formula
    carry = None          # a section number docling put in a cluster of its own ("23.", 5/2015)
    for j, (k, b) in enumerate(body[i:]):
        t = b["text"]
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
        if in_sched:
            put("schedule_text")
            continue
        if not quote and prev_text and not prev_quoted and INTRO.search(prev_text):
            quote = True
        m = SECTION.match(t)
        n = m and num_key(m[1])
        prev = last or (0, '')
        if not m and (m2 := SECTION_NODOT.match(t)) and num_key(m2[1]) == (prev[0] + 1, '') and any(
                x["page"] == b["page"] and abs(x["bbox"][1] - b["bbox"][1]) < 4 for x in notes):
            m, n = m2, num_key(m2[1])
        # an unclosed quote (closing mark never printed, 31/2022) ends at the next section number
        # level with an unquoted marginal note; inserted sections' notes start with a quote mark
        noted = any(x["page"] == b["page"] and abs(x["bbox"][1] - b["bbox"][1]) < 4 and x["text"][:1] not in QUOTES
                    for x in notes)
        if quote and m and n == (prev[0] + 1, '') and noted:
            quote = False
            warnings.append(f"unclosed quote ended at section {m[1]}")
        # the next number; a lettered one (12A) only right after its base (12); a jump (up to 10)
        # only with its own marginal note: numbered items of an inserted schedule have none (8/2012)
        if m and not quote and n > prev and (n[0] == prev[0] if n[1] else
                                             n[0] == prev[0] + 1 or (noted and n[0] <= prev[0] + 10)):
            last = n
            put("section_start")
            t = m[2]
        elif last is None:
            put("front")
            continue
        qd = quote_delta(t, quote)
        lm = LABEL.match(t)
        quoted = quote or t.lstrip()[:1] in QUOTES or bool(lm and lm[2][:1] in QUOTES)
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
    for k, b in body:
        kind, t = kinds.get(k, "section_text"), b["text"]
        if kind == "furniture":
            continue
        if kind == "front":
            if b["page"] == 1:
                if not doc["title"] and CITATION.search(t) and ' ACT' in (' ' + t.upper()):
                    doc["title"] = prev_p1 + ' ' + t if t.upper().startswith('ACT') and prev_p1 else t   # wrapped (22/2022)
                    m = CITATION.search(t)
                    doc["number"], doc["year"] = int(m[1]), int(m[2])
                if not doc["certified"] and CERTIFIED.search(t):
                    doc["certified"] = CERTIFIED.search(t)[1].strip(' ]')
                prev_p1 = t
            elif CERTIFIED.search(t):
                doc["certified"] = doc["certified"] or CERTIFIED.search(t)[1].strip(' ]')
            elif re.fullmatch(r"\[\s*(\d{1,2}\s*(?:st|nd|rd|th)?\s+[A-Za-z]+\s*,?\s*\d{4})\s*\]", t):
                # "[ 17th December , 1988 ]", the "th" a <sup>
                doc["certified"] = doc["certified"] or re.sub(r"(\d)\s+(st|nd|rd|th)\b", r"\1\2",
                                                              re.sub(r"\s+,", ",", t.strip("[] ")))
            elif re.match(r'^AN\s+ACT\b', t):
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
    for n in notes:
        if n["page"] in dropped:                 # e.g. the repeated copy of the Act (1/2010)
            continue
        hit = [b for _, b in body if b["page"] == n["page"] and b["bbox"][1] <= n["bbox"][3] and n["bbox"][1] <= b["bbox"][3]]
        s = next((openers[id(b)] for b in hit if id(b) in openers), None)
        if not s:
            # a note set a little below its opener line (19/2023 s31): the nearest opener above it on
            # the page that has no note yet, within 80 pt
            above = [o for o in openers.values() if o["_opener"]["page"] == n["page"] and not o["note"]
                     and 0 <= n["bbox"][1] - o["_opener"]["bbox"][1] < 80]
            s = max(above, key=lambda o: o["_opener"]["bbox"][1], default=None)
        if s and not s["note"]:
            s["note"] = n["text"]
        elif first and (n["page"], n["bbox"][1]) < first:
            doc["front"].append(n["text"])          # e.g. "Preamble"
        else:
            doc["warnings"].append(f"margin note not on a section opener, p{n['page']}: {n['text'][:60]}")
    for s in doc["sections"]:
        del s["_opener"]

    if doc["title"] and re.match(r'APPROPRIATION\s+ACT', doc["title"], re.I):   # amendments to one are fine
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
        if (b["role"] == "furniture" or b["page"] == 1 or CERTIFIED.search(t) or re.fullmatch(r'(PART|CHAPTER)\s+\S+', t)
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
