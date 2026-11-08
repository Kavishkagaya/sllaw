"""Stage 3 output -> paragraphs (docs/PIPELINE_V2.md).

Blocks come from the readers the current pipeline already has, one per engine: docling's text layer and the 1980
edition's word cells, LightOnOCR-3's grounding pages (etl.structure.chandra_pages), and HTML rows (lankalaw, the
1956 edition, CommonLII). `etl.structure.blocks()` gives every engine's output one shape: page, box (PDF points),
role (body | margin | furniture), text, and rows for a table. The body/margin role is decided there, per engine
and per page (the margin column moves page to page and differs by format); everything after it is generic.

Margin blocks (fixed 2026-11-07; today's etl.docs.block_paras drops what it cannot place): a margin block level
with a body block is that block's note; a fragment just below a note (under 9 pt, not level with an opener) is the
same note wrapped (laws only: a gazette has no marginal notes); any other margin block is body text, kept where it
is in reading order. The gate measured what dropping them lost: 1,018,485 words in 1,746 gazettes, 30,895 in 340
Acts (items, forms, schedules, whole sections), 7,050 in 322 chapters of the 1980 edition.
Not done (gate, 2026-11-07): reading a gazette's two columns in order. `columns()` (left column, then right) broke
single-column gazettes whose line starts docling cut into blocks of their own ("1.", "(1)", "a." beside the rest
of the line, gazette:2235/54): those need lines rebuilt from docling's word cells, a stage 3 fix.
"""
import re
from statistics import median

from etl.docs import gazette_body, join_split, split_spreads
from etl.structure import SECTION, blocks as engine_blocks, clean

STARTS = re.compile(r"^(?:\d{1,3}[A-Z]{0,4}\s*[.)]\s|\(\w{1,5}\)\s|[a-z]{1,4}[.)]\s|[ivx]{1,5}[.)]\s|[•●▪\-–]\s|PART\b|SCHEDULE\b|CHAPTER\b)")
FURN = {"page_header", "page_footer"}
MARKER = re.compile(r"(?:\d{1,3}[A-Z]{0,4}\s*[.)]|\(\w{1,5}\)|[a-z]{1,4}[.)]|[ivx]{1,5}[.)]|[•●▪])")


def _box(r):
    return min(r["r_x0"], r["r_x2"]), min(r["r_y0"], r["r_y2"]), max(r["r_x0"], r["r_x2"]), max(r["r_y0"], r["r_y2"])


def gazette_lines(raw, tables):
    """A text-layer gazette's pages -> blocks rebuilt from docling's line cells (2026-11-07): docling's layout
    clusters cut a line's start ("1.", "(1)", "a.") into a block of its own, beside the rest of the line, and the
    margin split then took it for a note (gazette:2235/54: "1." | "This regulation may be cited as ..."). Here a line
    is every line cell level with it, joined left to right, cut where a gap wider than 18 pt opens (a column
    gutter); a page with two columns of such lines is read left column, then right, between lines spanning the
    page; lines become paragraphs at a vertical gap, at a line opening a number, item or heading, or after a short
    line ending a sentence. Cells inside a page header or footer are furniture; tables come from `tables`
    (etl.structure.blocks' table blocks, page -> [block])."""
    out = []
    for pg in sorted(raw["docling"]["pages"], key=lambda p: p["page_no"]):
        pp, n = pg.get("parsed_page"), pg["page_no"]
        if not pp:
            continue
        W = pg["size"]["width"]
        clusters = pg["predictions"]["layout"]["clusters"]
        skip = [c["bbox"] for c in clusters if c["label"] in ("table", "picture")]
        furn = [c["bbox"] for c in clusters if c["label"] in FURN]
        inside = lambda b, bb: b[0] >= bb["l"] - 2 and b[2] <= bb["r"] + 2 and b[1] >= bb["t"] - 2 and b[3] <= bb["b"] + 2
        cells = []
        for c in pp.get("textline_cells") or pp.get("word_cells") or []:
            b = _box(c["rect"])
            if not c["text"].strip() or any(inside(b, bb) for bb in skip):
                continue
            cells.append((b, c["text"], any(inside(b, bb) for bb in furn)))
        # lines: cells whose vertical middles are within half a line height
        cells.sort(key=lambda c: ((c[0][1] + c[0][3]) / 2, c[0][0]))
        lines = []
        for b, t, f in cells:
            mid, h = (b[1] + b[3]) / 2, b[3] - b[1]
            ln = lines[-1] if lines else None
            if ln and abs(mid - ln["mid"]) <= max(3, 0.5 * min(h, ln["h"])):
                ln["cells"].append((b, t, f))
            else:
                lines.append({"mid": mid, "h": h, "cells": [(b, t, f)]})
        segs = []
        for ln in lines:
            cs = sorted(ln["cells"], key=lambda c: c[0][0])
            cur = [cs[0]]
            for c in cs[1:]:
                # a gap over 18 pt is a column gutter, unless what precedes it is only a number or a marker: a
                # hanging indent, "11."  "Every medicine registered ..." (gazette:2145/01)
                alone = MARKER.fullmatch("".join(t for _, t, _ in cur).strip())
                if c[0][0] - cur[-1][0][2] > 18 and not alone:
                    segs.append(cur)
                    cur = []
                cur.append(c)
            segs.append(cur)
        segs = [{"x0": min(c[0][0] for c in g), "x1": max(c[0][2] for c in g), "t": min(c[0][1] for c in g),
                 "b": max(c[0][3] for c in g), "furn": all(c[2] for c in g),
                 "text": clean("".join(t if (not i or g[i - 1][1].endswith(" ") or t.startswith(" ")) else " " + t
                                       for i, (_, t, _) in enumerate(g)))} for g in segs]
        segs = [g for g in segs if g["text"]]
        if not segs:
            continue
        x0, x1 = min(g["x0"] for g in segs), max(g["x1"] for g in segs)
        mid, w = (x0 + x1) / 2, max(1, x1 - x0)
        narrow = lambda g: g["x1"] - g["x0"] < 0.55 * w
        left = sum(narrow(g) and g["x1"] <= mid + 5 for g in segs)
        right = sum(narrow(g) and g["x0"] >= mid - 5 for g in segs)
        two = left >= 4 and right >= 4
        order = []
        if two:
            band = []
            for g in sorted(segs, key=lambda g: g["t"]):
                if narrow(g) and (g["x1"] <= mid + 5 or g["x0"] >= mid - 5):
                    band.append(g)
                else:
                    order += sorted(band, key=lambda g: (g["x0"] >= mid - 5, g["t"]))
                    band = []
                    order.append(g)
            order += sorted(band, key=lambda g: (g["x0"] >= mid - 5, g["t"]))
        else:
            order = sorted(segs, key=lambda g: (g["t"], g["x0"]))
        hs = [g["b"] - g["t"] for g in order]
        lh = median(hs) if hs else 10
        col = lambda g: (g["x0"] >= mid - 5) if two and narrow(g) else None
        paras, prev = [], None
        for g in order:
            joins = (prev and not g["furn"] and not prev["furn"] and col(g) == col(prev)
                     and 0 <= g["t"] - prev["b"] < 0.9 * lh and not STARTS.match(g["text"])
                     and not (re.search(r"[.:;]$", prev["text"]) and prev["x1"] - prev["x0"] < 0.7 * (w / (2 if two else 1))))
            if joins:
                q = paras[-1]
                q["text"] = q["text"] + ("" if q["text"].endswith("-") and g["text"][:1].islower() else " ") + g["text"]
                q["bbox"] = [min(q["bbox"][0], g["x0"]), q["bbox"][1], max(q["bbox"][2], g["x1"]), g["b"]]
            else:
                paras.append({"page": n, "label": "text", "role": "furniture" if g["furn"] else "body",
                              "bbox": [g["x0"], g["t"], g["x1"], g["b"]], "text": g["text"]})
            prev = g
        # a number printed a little above its text ("14." on a line of its own) opens the paragraph after it
        merged = []
        for q in paras:
            if merged and merged[-1]["role"] == "body" and q["role"] == "body" and MARKER.fullmatch(merged[-1]["text"].strip()):
                merged[-1] = {**q, "text": merged[-1]["text"].strip() + " " + q["text"]}
            else:
                merged.append(q)
        paras = merged
        # tables at their place, by their top
        for tb in tables.get(n, []):
            at = next((i for i, q in enumerate(paras) if q["bbox"][1] > tb["bbox"][1]), len(paras))
            paras.insert(at, tb)
        out += paras
    return out


def read(raw, lo, le1980=False, spread=False, gazette=False):
    """A file's raw (raw/v2) and LightOn pages (raw/lighton or None) -> (blocks, engine). A text-layer gazette's
    blocks are rebuilt from docling's line cells (gazette_lines); everything else as etl.structure.blocks()."""
    if spread and lo and lo.get("pages"):
        raw, lo = split_spreads(raw, lo)
    if lo and lo.get("pages"):
        raw = {**raw, "lighton": lo}
    engine = "lighton" if lo and lo.get("pages") else "html" if raw.get("format") == "html" else "docling"
    bs = engine_blocks(raw, le1980=le1980)
    if gazette and engine == "docling" and (raw.get("docling") or {}).get("pages") and not raw.get("ocr"):
        tables = {}
        for b in bs:
            if "rows" in b:
                tables.setdefault(b["page"], []).append(b)
        return gazette_lines(raw, tables), "docling-lines"
    return bs, engine


def table_text(rows):
    return "\n".join(" | ".join(c for c in r if c) for r in rows)


def paragraphs(bs, engine, gazette=False):
    """Blocks -> paragraphs in reading order, each {text, note, page, rows?}. -> (paragraphs, stats)."""
    opener_tops = {}
    for b in bs:
        if b["role"] == "body" and SECTION.match(b["text"]):
            opener_tops.setdefault(b["page"], []).append(b["bbox"][1])
    # margin blocks top to bottom per page; a fragment just below the previous one is the same note, wrapped
    groups = []
    for m in sorted((b for b in bs if b["role"] == "margin"), key=lambda b: (b["page"], b["bbox"][1])):
        g = groups[-1] if groups else None
        if (g and not gazette and g["page"] == m["page"] and m["bbox"][1] - g["bbox"][3] < 9
                and not any(abs(m["bbox"][1] - t) < 5 for t in opener_tops.get(m["page"], []))):
            g["text"] += " " + m["text"]
            g["bbox"] = [min(g["bbox"][0], m["bbox"][0]), g["bbox"][1], max(g["bbox"][2], m["bbox"][2]), m["bbox"][3]]
        else:
            groups.append({"page": m["page"], "bbox": list(m["bbox"]), "text": m["text"], "first": id(m)})
    paras, at = [], {}
    for b in bs:
        if b["role"] == "body":
            p = {"text": table_text(b["rows"]) if "rows" in b else b["text"], "note": None, "page": b["page"], "_b": b["bbox"]}
            if "rows" in b:
                p["rows"] = b["rows"]
            paras.append(p)
        elif b["role"] == "margin":
            at[id(b)] = len(paras)          # where a margin block would sit as body text
    moved, notes = [], 0
    for g in groups:
        level = [p for p in paras if p["page"] == g["page"] and p["_b"][1] - 4 <= g["bbox"][3] and g["bbox"][1] <= p["_b"][3]]
        if level:
            p = min(level, key=lambda p: abs(p["_b"][1] - g["bbox"][1]))
            p["note"] = f"{p['note']} {g['text']}" if p["note"] else g["text"]
            notes += 1
        else:
            moved.append((at[g["first"]], {"text": g["text"], "note": None, "page": g["page"], "_b": g["bbox"]}))
    for i, p in sorted(moved, key=lambda x: -x[0]):    # from the end, so earlier positions stay right
        paras.insert(i, p)
    for p in paras:
        del p["_b"]
    if engine == "lighton":
        paras = join_split(paras)
    if gazette:
        paras = gazette_body(paras)
    stats = {"furniture": sum(len(b["text"]) for b in bs if b["role"] == "furniture"),
             "notes": notes, "margin_as_body": len(moved),
             "margin_as_body_words": sum(len(p["text"].split()) for _, p in moved),
             "notes_unplaced": 0, "notes_unplaced_words": 0, "notes_unplaced_sample": []}
    return [p for p in paras if p["text"].strip()], stats
