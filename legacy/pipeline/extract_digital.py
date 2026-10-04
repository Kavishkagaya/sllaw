"""Digital PDF -> sections. v14

Fixes over v3:
  1. pages with no marginal column are no longer SKIPPED (they were losing
     ~85% of sections) - they fall back to single-column body.
  2. quoted insertions ("...the following section is substituted therefor-
     '12. The word ...'") are no longer read as sections of THIS act.
"""
import sys, re, json, collections, pypdfium2 as pdfium


# A SCHEDULE contains numbered ITEMS that look exactly like sections but are not.
# Two ways one starts: a heading line, or a section announcing it amends/replaces one.
SCHED_HEAD = re.compile(
    r'^\s*((FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH'
    r'|\d+(?:ST|ND|RD|TH))\s+)?SCHEDULE\b', re.I)
SCHED_INTRO = re.compile(
    r'\b(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|'
    r'[IVX]+)?\s*schedule\b[^.]{0,80}?\b(?:amended|repealed|substituted|inserted|added)\b',
    re.I)

SECTION = re.compile(r'^\s*(\d+[A-Z]*)\.\s')
OPEN_Q, CLOSE_Q = '“', '”'



TOC_MARK = re.compile(r'TABLE OF SECTIONS|ARRANGEMENT OF SECTIONS|^\s*Sections?\s+Page\s*$',
                      re.I | re.M)
TOC_LINE = re.compile(r'(?m)^\s*\d+[A-Z]*\.\s+\S.*?\s+\d{1,4}\s*$')
SEC_LINE = re.compile(r'(?m)^\s*\d+[A-Z]*\.\s+\S')


def is_toc_page(raw):
    """A contents page: explicit marker, or most numbered lines end in a page no."""
    if TOC_MARK.search(raw):
        return True
    n_sec = len(SEC_LINE.findall(raw))
    if n_sec >= 4 and len(TOC_LINE.findall(raw)) >= n_sec * 0.6:
        return True
    return False


def col_cut(tp, bin_w=5, min_ratio=0.005, max_ratio=0.35):
    """Return (cut_x, side) for the body|margin split, or (None, None).

    Find the deepest low-density band; whichever side of it holds a small but
    non-trivial share of the page's text is the marginal column. Measured on
    real acts: genuine margins are 1.5-4% of page text, noise is ~0.1%.
    Recto pages carry the margin on the right, verso on the left.
    """
    d = collections.Counter()
    for i in range(tp.count_chars()):
        x0, _, x1, _ = tp.get_charbox(i)
        for x in range(int(x0), max(int(x0)+1, int(x1))): d[x] += 1
    if not d: return None, None
    lo, hi = min(d), max(d)
    if hi - lo < 50: return None, None
    total = sum(d.values())
    if total < 200: return None, None

    bins = [(x, sum(d.get(k, 0) for k in range(x, x+bin_w)))
            for x in range(lo, hi - bin_w, bin_w)]
    if not bins: return None, None
    peak = max(n for _, n in bins)

    best = None
    for x, n in sorted(bins, key=lambda b: b[1]):
        if n >= peak * 0.2: break
        left = sum(v for k, v in d.items() if k < x)
        right = sum(v for k, v in d.items() if k > x + bin_w)
        for side, share in (("left", left/total), ("right", right/total)):
            if min_ratio <= share <= max_ratio:
                score = -n                      # prefer the emptiest gap
                if best is None or score > best[0]:
                    best = (score, x + bin_w/2, side)
    if best is None: return None, None
    return best[1], best[2]


def bands(tp, x_lo, x_hi, line_tol=4.0, block_gap=7.0):
    cs = []
    for i in range(tp.count_chars()):
        x0, y0, x1, y1 = tp.get_charbox(i)
        if x_lo <= (x0+x1)/2 < x_hi and tp.get_text_range(i, 1).strip():
            cs.append(((y0+y1)/2, y0, y1))
    if not cs: return []
    cs.sort(key=lambda c: -c[0])
    lines, cur, cc = [], [cs[0]], cs[0][0]
    for c in cs[1:]:
        if abs(c[0]-cc) <= line_tol: cur.append(c)
        else: lines.append(cur); cur, cc = [c], c[0]
    lines.append(cur)
    lines = [(max(c[2] for c in l), min(c[1] for c in l)) for l in lines]
    out = []
    for y1, y0 in lines:
        if out and out[-1][1] - y1 <= block_gap:
            out[-1] = (out[-1][0], min(out[-1][1], y0))
        else: out.append((y1, y0))
    return out



def longest_increasing(secs):
    """Real sections increase monotonically through the document; quoted
    insertions from the principal enactment are out-of-order noise. Keep the
    longest strictly increasing subsequence of section numbers."""
    if not secs: return secs
    n = len(secs)
    GAP = 2.0        # cost of skipping a section number: real acts run 1,2,3...
    # a chain that must jump 2 -> 8 is a schedule, not the act's own sections
    best = [1.0 - GAP * (secs[i]["_n"] - 1) for i in range(n)]
    prev = [-1]*n
    for i in range(n):
        for j in range(i):
            if secs[j]["_n"] < secs[i]["_n"]:
                cand = best[j] + 1 - GAP * (secs[i]["_n"] - secs[j]["_n"] - 1)
                if cand > best[i]:
                    best[i], prev[i] = cand, j
    i = max(range(n), key=lambda k: best[k])
    keep = []
    while i != -1:
        keep.append(i); i = prev[i]
    keep = set(keep)
    out, dropped = [], []
    for idx, s in enumerate(secs):
        if idx in keep: out.append(s)
        else: dropped.append(s)
    # text of dropped candidates belongs to the preceding kept section
    for d in dropped:
        host = None
        for s in out:
            if (s["page"], s["_y_top"]) <= (d["page"], 1e9) and \
               (s["page"] < d["page"] or s["_y_top"] >= d["_y_top"]):
                host = s
        if host is not None:
            host["body"].extend(d["body"])
    return out


def extract(path):
    doc = pdfium.PdfDocument(path)
    secs, last, margins, in_sched = [], None, {}, False
    for pno in range(len(doc)):
        p = doc[pno]; w, h = p.get_size(); tp = p.get_textpage()
        if tp.count_chars() == 0: continue
        if is_toc_page(tp.get_text_range()):    # skip contents pages entirely
            continue
        cut, side = col_cut(tp)
        if cut is None:
            b_lo, b_hi, m_lo, m_hi = 0, w, None, None
        elif side == 'right':
            b_lo, b_hi, m_lo, m_hi = 0, cut, cut, w
        else:                                   # verso: margin on the LEFT
            b_lo, b_hi, m_lo, m_hi = cut, w, 0, cut
        body = [(y1, y0, tp.get_text_bounded(b_lo, y0-1, b_hi, y1+1).strip())
                for y1, y0 in bands(tp, b_lo, b_hi)]
        marg = ([(y1, y0, " ".join(tp.get_text_bounded(m_lo, y0-1, m_hi, y1+1).split()))
                 for y1, y0 in bands(tp, m_lo, m_hi, block_gap=0)]
                if m_lo is not None else [])
        for by1, by0, bt in body:
            flat = " ".join(bt.split())
            m = SECTION.match(flat)
            has_note = any(by0 - 3 <= (my1 + my0) / 2 <= by1 + 3 for my1, my0, _ in marg)
            if SCHED_HEAD.match(flat):
                in_sched = True                    # heading: everything after is schedule
            real = bool(m) and not (in_sched and not has_note)
            if m and has_note:
                in_sched = False                   # a labelled opener resumes the act
            if real and SCHED_INTRO.search(flat):
                in_sched = True                    # "...the Third Schedule ... is amended"
            if real:
                secs.append({"page": pno+1, "number": m.group(1), "marginal_note": None,
                             "body": [flat], "_y_top": by1, "_y_bot": by0,
                             "_n": int(re.match(r'\d+', m.group(1)).group())})
            elif secs:
                secs[-1]["body"].append(flat)
                if secs[-1].get("page") == pno+1:
                    secs[-1]["_y_bot"] = min(secs[-1]["_y_bot"], by0)
        margins[pno+1] = marg          # bind AFTER selection, not now

    secs = longest_increasing(secs)
    attach_notes(secs, margins)
    for s in secs:
        s.pop('_y_top', None); s.pop('_y_bot', None); s.pop('_n', None)
    return secs


def attach_notes(secs, margins):
    """Assign margin lines to the SURVIVING sections.

    Done after selection: a section's true vertical extent runs from its own
    opener down to the next surviving opener on that page. Binding before
    selection let dropped candidates (quoted insertions) swallow their
    neighbours' notes.
    """
    by_page = {}
    for s in secs:
        by_page.setdefault(s["page"], []).append(s)
    for page, lines in margins.items():
        on_page = sorted(by_page.get(page, []), key=lambda s: -s["_y_top"])
        if not on_page or not lines:
            continue
        spans = []
        for i, s in enumerate(on_page):
            top = s["_y_top"] + 4
            bot = on_page[i+1]["_y_top"] if i + 1 < len(on_page) else -1e9
            spans.append((top, bot, s))
        for my1, my0, mt in lines:
            mc = (my1 + my0) / 2
            tgt = next((s for top, bot, s in spans if bot < mc <= top), None)
            if tgt is None:                     # above the first opener on the page
                tgt = on_page[0] if mc > spans[0][0] else None
            if tgt is not None:
                tgt["marginal_note"] = ((tgt["marginal_note"] + " ")
                                        if tgt["marginal_note"] else "") + mt


def audit(secs):
    nums = [s["number"] for s in secs]
    ints = [int(re.match(r'\d+', n).group()) for n in nums]
    dupes = sorted({n for n in nums if nums.count(n) > 1})
    gaps = [i for i in range(1, max(ints) + 1) if i not in ints] if ints else []
    return {"found": len(secs), "max": max(ints) if ints else 0,
            "dupes": len(dupes), "gaps": len(gaps),
            "dupe_list": dupes[:6], "gap_list": gaps[:12]}


if __name__ == "__main__":
    s = extract(sys.argv[1])
    a = audit(s)
    print(json.dumps(a))
    if len(sys.argv) > 2: json.dump(s, open(sys.argv[2], "w"), indent=1)
