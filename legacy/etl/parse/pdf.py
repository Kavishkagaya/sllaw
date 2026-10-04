"""PDF -> breadcrumbed chunks. One responsibility: bytes in, chunks out.

Anchors (each becomes a chunk):  preamble | part | chapter | section | schedule
Stripped as noise:               running headers, printer trailer

ponytail: schedule sub-items (1., 2. inside a SCHEDULE) stay in one chunk.
Split them when a retrieval miss proves item-level granularity is needed.
"""
import re, sys, json, collections

OPEN_Q, CLOSE_Q = '“', '”'
MAX_CHARS = 1200

ORD  = r'FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH'
PART    = re.compile(rf'^PART\s+([IVXL]+)\b')
CHAPTER = re.compile(r'^CHAPTER\s+([IVXL]+|\d+)\b')
SCHED   = re.compile(rf'^((?:{ORD}|\d+(?:ST|ND|RD|TH))\s+)?SCHEDULE\b', re.I)
SECTION = re.compile(r'^(\d+[A-Z]*)\.\s')
TRAILER = re.compile(r'PRAKASHANA|GOVERNMENT PRINTING|can be purchased', re.I)
# short docs repeat their header only once or twice, too rare for the frequency
# test, but the header always carries the act's citation and a bare page number
CITATION = re.compile(r'(?:Act|Ordinance|Law),?\s*No\.?\s*\d+\s+of\s+\d{4}')


def _is_header(t):
    return (len(t) < 100 and CITATION.search(t) and not t[-1:] in '.;:,'
            and not SECTION.match(t))


def strip_noise(blocks):
    """Running headers repeat on most pages; the only stable signal is that the
    line, with its page number removed, recurs. Frequency beats title-parsing."""
    norm = lambda t: re.sub(r'\W+', '', re.sub(r'\d+', '', t)).lower()
    freq = collections.Counter(norm(b["text"]) for b in blocks if len(b["text"]) < 120)
    out, dropped = [], []
    for b in blocks:
        t = b["text"].strip()
        if TRAILER.search(t):
            continue
        if CITATION.search(t) and len(t) < 100:
            dropped.append(t)
        # a vetted opener is never noise: amendment sections all read
        # "N. Section M of the principal enactment is hereby amended", which
        # normalises to one string once digits are stripped and would otherwise
        # look like a line repeating on every page
        if b.get("opener") or SECTION.match(t):
            out.append(b)
            continue
        if norm(t) and (freq[norm(t)] >= 3 and len(t) < 120 or _is_header(t)):
            continue                                   # running header
        if re.fullmatch(r'\d{1,4}', t):
            continue                                   # bare page number
        out.append(b)
    return out, dropped


def anchor_of(t, split_numeric=True):
    m = PART.match(t)
    if m: return "part", f"PART {m.group(1)}"
    m = CHAPTER.match(t)
    if m: return "chapter", f"CHAPTER {m.group(1)}"
    m = SCHED.match(t)
    if m: return "schedule", re.sub(r'\s+', ' ', m.group(0)).upper()
    m = SECTION.match(t)
    if m and (split_numeric or not m.group(1).isdigit()):
        return "section", m.group(1)
    return None


def build(blocks, *, title="", split_numeric=True):
    """blocks: [{"page": int, "text": str, "note": str|None}] in document order."""
    blocks, headers = strip_noise(blocks)
    if not title and headers:
        # the page number can sit at either end or in the middle of the header,
        # so match the citation itself rather than trying to strip digits first
        cite = re.compile(r"([A-Za-z][A-Za-z'()\u2019\- ]{2,80}?)\s*(?:\d{1,3}\s+)?"
                          r"((?:Act|Ordinance|Law),?\s*No\.?\s*\d+\s+of\s+\d{4})")
        seen = collections.Counter()
        for h in headers:
            m = cite.search(h)
            if m:
                seen[f"{m.group(1).strip()} {m.group(2)}"] += 1
        if seen:
            title = seen.most_common(1)[0][0]
    chunks, cur, depth, part, chap, in_sched = [], None, 0, None, None, False
    for b in blocks:
        t = " ".join(b["text"].split())
        if not t:
            continue
        # a quoted insertion is the principal enactment's text, not this act's
        hit = anchor_of(t, split_numeric) if depth == 0 and not t.startswith(OPEN_Q) else None
        # the layout pass already vetted openers by monotonic selection, so it
        # outranks quote depth here: one unbalanced quote in the text layer
        # would otherwise suppress every remaining section in the document
        if hit is None and b.get("opener") and not t.startswith(OPEN_Q):
            hit = anchor_of(t, split_numeric)
            if hit:
                depth = 0
        # inside a SCHEDULE the numbered items look exactly like sections but
        # are not; only a labelled opener (one carrying a marginal note) resumes
        if hit and hit[0] == "section" and in_sched and not b.get("note"):
            hit = None
        # a section number inside a section's body is the principal enactment's,
        # not this act's — the layout pass already rejected it as an opener
        if hit and hit[0] == "section" and b.get("opener") is False:
            hit = None
        depth = max(0, depth + t.count(OPEN_Q) - t.count(CLOSE_Q))
        if hit:
            kind, anchor = hit
            in_sched = kind == "schedule"
            if kind == "part":    part, chap = anchor, None
            if kind == "chapter": chap = anchor
            cur = {"kind": kind, "anchor": anchor, "note": b.get("note"),
                   "part": part, "chapter": chap,
                   "pages": [b["page"]] if b.get("page") else [], "lines": [t]}
            chunks.append(cur)
            continue
        if cur is None:                                # front matter before s.1
            cur = {"kind": "preamble", "anchor": None, "note": None, "part": None,
                   "chapter": None, "pages": [b["page"]] if b.get("page") else [], "lines": []}
            chunks.append(cur)
        cur["lines"].append(t)
        if b.get("page") and b["page"] not in cur["pages"]:
            cur["pages"].append(b["page"])
        if cur["note"] is None and b.get("note"):
            cur["note"] = b["note"]
    return [c for c in _split_long(chunks, title) if c["text"].strip()]


def _crumb(title, c, part=None, of=None):
    bits = [title] if title else []
    bits += [x for x in (c["part"], c["chapter"]) if x]
    label = {"section": f"s. {c['anchor']}", "preamble": "Preamble"}.get(c["kind"], c["anchor"])
    bits.append(label)
    if c["note"]:
        bits.append(c["note"])
    if of and of > 1:
        bits.append(f"({part}/{of})")
    return " › ".join(bits)


def _split_long(chunks, title):
    out = []
    for c in chunks:
        paras, buf = [], ""
        for ln in c["lines"]:
            if buf and len(buf) + len(ln) > MAX_CHARS:
                paras.append(buf); buf = ln
            else:
                buf = f"{buf}\n\n{ln}" if buf else ln
        if buf:
            paras.append(buf)
        for i, p in enumerate(paras):
            out.append({k: c[k] for k in ("kind", "anchor", "note", "part", "chapter")}
                       | {"pages": c["pages"], "text": p,
                          "breadcrumb": _crumb(title, c, i + 1, len(paras))})
    for i, c in enumerate(out):
        c["idx"] = i
    return out


def parse(path):
    """layout gives columns + notes but starts at section 1; the front matter
    (long title, enacting formula, certification) is read separately."""
    import pypdfium2 as pdfium
    from . import layout as ed

    secs = ed.extract(path)
    first = (secs[0]["page"], secs[0]["body"][0][:40]) if secs else (10**6, "")
    front, doc = [], pdfium.PdfDocument(path)
    for pno in range(min(first[0], len(doc))):
        pg = doc[pno]; w, _ = pg.get_size(); tp = pg.get_textpage()
        if tp.count_chars() == 0 or ed.is_toc_page(tp.get_text_range()):
            continue
        cut, side = ed.col_cut(tp)
        lo, hi = (0, w) if cut is None else ((0, cut) if side == 'right' else (cut, w))
        for y1, y0 in ed.bands(tp, lo, hi):
            t = " ".join(tp.get_text_bounded(lo, y0 - 1, hi, y1 + 1).split())
            if not t:
                continue
            if pno + 1 == first[0] and t[:40] == first[1]:
                break                       # reached section 1, stop
            front.append({"page": pno + 1, "text": t, "note": None, "opener": False})
        else:
            continue
        break

    blocks = front + [
        {"page": (s.get("body_pages") or [s["page"]] * len(s["body"]))[j],
         "text": ln, "opener": j == 0,
         "note": s.get("marginal_note") if j == 0 else None}
        for s in secs for j, ln in enumerate(s["body"])]
    return build(blocks)


def _selfcheck():
    B = lambda p, t, n=None: {"page": p, "text": t, "note": n}
    hdr = [B(i, "Widgets Act, No. 3 of 2020 %d" % i) for i in range(1, 5)]
    ch = build([B(1, "AN ACT TO PROVIDE FOR WIDGETS"),
                B(1, "1. Short title.", "Short title"),
                *hdr,
                B(2, "PART I"),
                B(2, "2. Widgets are good."),
                B(2, "3. Section 9 is amended by inserting-"),
                B(2, f"{OPEN_Q}9A. This is quoted text.{CLOSE_Q}"),
                B(3, "FIRST SCHEDULE"),
                B(3, "1. Repealed: Old Act."),
                B(4, "PRAKASHANA PIYASA, DEPARTMENT OF GOVERNMENT PRINTING")],
               title="Widgets Act")
    kinds = [c["kind"] for c in ch]
    assert kinds == ["preamble", "section", "part", "section", "section", "schedule"], kinds
    assert [c["anchor"] for c in ch][1] == "1"
    assert ch[-1]["anchor"] == "FIRST SCHEDULE", ch[-1]
    assert ch[-1]["kind"] == "schedule"
    assert "9A." in ch[4]["text"], "quoted insertion must stay inside its host"
    assert not any("PRAKASHANA" in c["text"] for c in ch), "trailer not stripped"
    assert not any(re.search(r'No\. 3 of 2020 \d', c["text"]) for c in ch), "header not stripped"
    assert ch[3]["part"] == "PART I" and "PART I" in ch[3]["breadcrumb"]
    assert ch[1]["breadcrumb"] == "Widgets Act › s. 1 › Short title", ch[1]["breadcrumb"]
    # title is derived from the modal running header when not supplied
    auto = build([B(i, "Widgets Act, No. 3 of 2020 %d" % i) for i in range(1, 5)]
                 + [B(1, "1. Short title.", "Short title")])
    assert auto[0]["breadcrumb"].startswith("Widgets Act, No. 3 of 2020 \u203a"), auto[0]["breadcrumb"]
    print("selfcheck ok:", len(ch), "chunks; title ->", auto[0]["breadcrumb"])


if __name__ == "__main__":          # python3 -m etl.parse.pdf [file.pdf]
    if len(sys.argv) > 1:
        json.dump(parse(sys.argv[1]), sys.stdout, indent=1)
    else:
        _selfcheck()
