#!/usr/bin/env python3
"""Documents, their text in chunks, and links between documents (Neon `docs`, `chunks`, `links`; migration 003).

  python3 -m etl.docs build [--keys act:12/2002,...] [--limit N]   # raw (R2) -> docs + chunks, then links
  python3 -m etl.docs relink [--keys ...]                         # links again from the chunks in the database
  python3 -m etl.docs keys [--fix]                                # files under the wrong key (short title vs key)
  python3 -m etl.docs show act:12/2002                             # print a document's chunks (no writes)

No section/schedule assembly (decision 2026-10-10, user). A document's text is read in reading order:
  PDFs   LightOnOCR-3's page markdown (raw/lighton, etl.ocr): blocks `![label](x0,y0,x1,y1) text` on a 0-1000 grid.
         Marginal notes come as an italic tail on the section's block ("1. This Act may be cited as ... *Short
         title.*"), or as their own block in the margin column (italic `text`, or `aside_text`); a note block goes
         onto the body block level with it. Page furniture (header, page_number, footer, image, text+) is dropped.
  HTML   the same form, from etl.structure.blocks() (body and margin cells of the 1956 edition, lankalaw, CommonLII).
The text is cut into chunks at section openers ("22. ...", "12A. ...") and at Part / Chapter / Schedule headings;
a chunk's label is what it opens, in the form links use ("22", "First Schedule"). Links come from each chunk's
text alone (etl/refs.py; marginal notes are not read, decision 2026-10-10).
"""
import argparse, gzip, html, json, os, re
from concurrent.futures import ProcessPoolExecutor

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl import refs
from etl.fetch import pg_connect
from etl.structure import SCHED_HEAD, blocks, sched_name

load_dotenv()
BUILD = "2026-10-18"   # 18: notes at the end of a chunk's first piece, cover furniture, titled contents pages, issue #23
                       # 16: contents pages dropped, path (breadcrumb), MAX 3000 -> 1500
BLOCK = re.compile(r"!\[([\w+-]+)\]\((\d+),(\d+),(\d+),(\d+)\)[ \t]*\n?(.*?)(?=\n!\[[\w+-]+\]\(\d|\Z)", re.S)
DROP = {"header", "page_number", "footer", "image", "footer_image", "text+", "page_footer", "page_header"}
OPENER = re.compile(r"^(\d{1,3}[A-Z]{0,4})\s*\.\s+\S")        # "22. (1) The ...", "12A. Where ..."; not "“25A." (quoted)
HEADING = re.compile(r"^(?:#+\s*)?\**\s*(PART|CHAPTER)\s+([IVXLC]+[A-Z]?|\d+)\b", re.I)
# the cover's printing lines, not law (act:24/2019 chunk 0 was cited, issue #23); only before the first section
FURNITURE = re.compile(r"^(?:logo\b|QR code$|Printed (?:on the Orders? of Government|at the)|Published as a Supplement|"
                       r"TO BE PURCHASED|(?:Price|Postage)\s*:|This Act can be downloaded|L\.\s*D\.\s*[—–-]\s*O\.|"
                       r"\d+(?:st|nd|rd|th) Session\b)", re.I)
MAX = 1500                                                    # chars; a longer chunk is cut at paragraph ends
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}
MID_PART = re.compile(r"\n\s*\**\s*PART\s+[IVXLC]+[A-Z]?\b")       # an upper-case Part heading inside a paragraph


def table_text(h):
    """<table>...</table> -> one line per row, cells joined by ' | '."""
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
        cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if any(cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def is_note(label, x0, x1, t):
    """A marginal note block: LightOn's aside_text, or a short italic block in a narrow column at either edge."""
    if label == "aside_text":
        return True
    s = t.strip()
    return (label == "text" and (x1 - x0) < 300 and (x0 > 650 or x1 < 350) and len(s) < 200
            and s.startswith("*") and s.rstrip(".").endswith("*"))


def lighton_paras(lo):
    """LightOn pages -> paragraphs in reading order, each a dict {text, note}; notes attached to the body block
    level with them (same page, overlapping y), else to the body block just above."""
    out = []
    for p in sorted(lo["pages"], key=lambda p: p["page_no"]):
        if p.get("finish") != "stop":
            continue
        body, notes = [], []
        for m in BLOCK.finditer(p["md"]):
            label, x0, y0, x1, y1, t = m[1], *map(int, m.groups()[1:5]), m[6].strip()
            if label in DROP or not t:
                continue
            if label == "table" or t.startswith("<table"):
                t = table_text(t)
            if is_note(label, x0, x1, t):
                notes.append((y0, y1, t.strip("* ").strip()))
            else:
                body.append({"text": t, "note": None, "y": (y0, y1)})
        for y0, y1, n in notes:
            level = [b for b in body if b["y"][0] - 15 <= y1 and y0 <= b["y"][1] + 15]
            above = [b for b in body if b["y"][0] <= y0]
            hit = (min(level, key=lambda b: abs(b["y"][0] - y0)) if level else (above[-1] if above else None))
            if hit:
                hit["note"] = f"{hit['note']} {n}" if hit["note"] else n
        out += body
    for b in out:
        b.pop("y", None)
        # the note LightOn printed inline: a trailing italic on a section's block ("... of 2002. *Short title.*")
        if (m := re.search(r"\s\*([^*]{3,200})\*\s*$", b["text"])) and OPENER.match(b["text"]):
            b["text"], b["note"] = b["text"][:m.start()].rstrip(), (m[1].strip() + (f" {b['note']}" if b["note"] else ""))
    return out


def block_paras(bs):
    """etl.structure.blocks() output (HTML, or a text layer) -> the same paragraphs: body blocks in order, a
    margin block's text as the note of the body block level with it on its page."""
    out, last = [], {}
    body = [b for b in bs if b["role"] == "body"]
    for b in body:
        t = b["text"] if "rows" not in b else "\n".join(" | ".join(c for c in r if c) for r in b["rows"])
        out.append({"text": t, "note": None, "_b": b})
    for n in (b for b in bs if b["role"] == "margin"):
        level = [p for p in out if p["_b"]["page"] == n["page"] and p["_b"]["bbox"][1] - 4 <= n["bbox"][3]
                 and n["bbox"][1] <= p["_b"]["bbox"][3]]
        if level:
            p = min(level, key=lambda p: abs(p["_b"]["bbox"][1] - n["bbox"][1]))
            p["note"] = f"{p['note']} {n['text']}" if p["note"] else n["text"]
    for p in out:
        del p["_b"]
    return out


SPLIT_END = re.compile(r"[a-z,]$")                              # "... of such fact and the" / "Regulatory Council shall"
SPLIT_START = re.compile(r"^(?![A-Z]{2,}\b)[A-Za-z]")          # not a heading: "THIRD SCHEDULE", "PART II"


def join_split(paras):
    """One sentence that LightOn cut into two blocks (or across a page) back into one paragraph: the first is a
    line of body text (60+ chars) ending mid-sentence (a lower-case letter or a comma), the second opens nothing (no
    number, "(a)", heading, table, cover line). act:21/2006 s4 read "...of such fact and the" / "Regulatory Council
    shall thereupon..." (issue #23). LightOn only: the HTML and 1980 docling text joined titles to long titles and
    1980 lines out of order (18% of docling paragraphs, measured 2026-10-20); shorter first blocks were cover lines,
    table cells and headings ("Ministry of Samurdhi" / "Recurrent")."""
    out = []
    for p in paras:
        a = out[-1]["text"].rstrip() if out else ""
        if (len(a) >= 60 and SPLIT_END.search(a) and SPLIT_START.match(p["text"]) and not a.startswith("#")
                and not FURNITURE.match(a) and not FURNITURE.match(p["text"])
                and " | " not in a + p["text"] and not HEADING.match(p["text"])):
            q = out[-1]
            q["text"] = f"{a} {p['text']}"
            q["note"] = " ".join(n for n in (q["note"], p["note"]) if n) or None
        else:
            out.append(p)
    return out


def num_key(n):
    m = re.match(r"(\d+)([A-Z]*)", n)
    return int(m[1]), m[2]


def drop_contents(paras):
    """Paragraphs without the contents page ("Arrangement of sections"): its lines read as section openers
    ("3. Establishment of the Authority", then "15", its page) and took the labels 1, 2, 3 ... from the body's
    sections (act:7/2007, act:38/2000: 2026-10-16). Dropped: the paragraphs from the document's first numbered
    paragraph, a "1.", up to the next "1.", when that one reads as a section (60+ chars or a note), at least 5
    openers lie between and 80% of them are short lines that don't end like a sentence. A schedule's numbered list
    passes the last two tests (countries, councils, chemicals: cap:314, act:38/1988, act:1/2008) but never comes
    first. -> (paragraphs, number dropped)"""
    ops = [i for i, p in enumerate(paras) if OPENER.match(p["text"].strip())]
    ones = [i for i in ops if OPENER.match(paras[i]["text"].strip())[1] == "1"]
    if len(ones) < 2 or ones[0] != ops[0]:
        return paras, 0
    a, b = ones[:2]
    # a section: 60+ chars, a note, or (1980 chapters printed without a margin: cap:235, cap:492) its note as the
    # opener line, "1. Short title.", with the text in the paragraph after it
    after = paras[b + 1]["text"].strip() if b + 1 < len(paras) else ""
    text_after = not OPENER.match(after) and (len(after) >= 60 or (len(after) >= 30 and after.endswith(".")))
    if len(paras[b]["text"].strip()) < 60 and not paras[b]["note"] and not text_after:
        return paras, 0
    lines = [t for p in paras[a:b] if OPENER.match(t := p["text"].strip())]
    entry = [t for t in lines if len(t) < 150 and not re.sub(r"\s+\d{1,4}$", "", t).rstrip("*").endswith((".", ":", "-", "—"))]
    # headed "Arrangement of Sections": its entries may end in a full stop ("1. Short title.", cap:235)
    titled = any(re.search(r"arrangement\s+of\s+sections|^contents$", p["text"].strip(), re.I) for p in paras[max(0, a - 3):a])
    if len(lines) >= 5 and (titled or len(entry) >= 0.8 * len(lines)):
        return paras[:a] + paras[b:], b - a
    return paras, 0


def roman(s):
    v = [ROMAN.get(c, 0) for c in s]
    return sum(-x if i + 1 < len(v) and x < v[i + 1] else x for i, x in enumerate(v))


def chunks(paras, word="section", parts=True):
    """Paragraphs -> [(label, text, path)]: a new chunk at each section opener and each Part/Chapter/Schedule
    heading; a section's note follows its first line as an italic tail, the form LightOn prints. Over MAX, cut at a
    paragraph end (the label stays on the first piece). The contents page is dropped first (drop_contents), and
    the cover's printing lines (FURNITURE). A chunk's notes go at the end of its first piece, not after the block
    they were level with: LightOn splits a sentence into blocks, so that put a note mid-sentence (act:21/2006 s4,
    issue #23); a piece ends at a paragraph end, and refs.py still reads the note-form links in the same chunk.
    A numbered paragraph opens a section only if it continues the sequence: the next number, a lettered one of
    the same base (12 -> 12A), or a jump of up to 10 with its own note (numbers lost to OCR). After a schedule
    heading, numbered items are the schedule's ("1. Name of applicant"), until the next section number appears
    with a note (1980 chapters print schedules between sections). On 1,528 LightOn laws, openers without this
    rule went backwards 1,570 times (2026-10-10).
    path = breadcrumb, "Part II — Powers of the Council › section 13 — Powers (cont.)"; anything not certain is
    left out, never guessed (user, 2026-10-16): only the latest Part/Chapter heading, and only while its numbers
    run in order from I (a break - contents residue, a quoted inserted Part, OCR - ends Parts for the document;
    so does an upper-case PART inside a paragraph); none in amending Acts (parts=False: they quote other laws'
    Parts) or schedules; a note over 100 chars is left out; "(cont.)" only on a piece this function cut, and not
    once the chunk holds a rejected opener (a section may have been missed there)."""
    paras = drop_contents(paras)[0]
    first = next((i for i, p in enumerate(paras) if OPENER.match(p["text"].strip())), len(paras))
    paras = [p for i, p in enumerate(paras) if i >= first or not FURNITURE.match(p["text"].strip())]
    out, cur, label, last, in_sched, notes = [], [], None, (0, ""), False, []
    # a law printed without a margin (notes on under 10% of its numbered paragraphs) has no notes to vouch for a
    # jump (cap:235 lost s34 to OCR, and every later section with it): there any jump of up to 10 opens a section
    numbered = [p for p in paras if OPENER.match(p["text"].strip())]
    noteless = sum(bool(p["note"]) for p in numbered) < 0.1 * len(numbered)
    head, seen, path, bad = None, {}, None, []        # bad[i]: cur[i] is an opener rejected outside a schedule
    def close():
        piece, n, first, doubt, at = [], 0, True, False, len(out)
        for t, b in zip(cur, bad):
            if piece and n + len(t) > MAX:
                out.append((label if first else None, "\n\n".join(piece),
                            path if first else None if doubt or not path else path + " (cont.)"))
                piece, n, first = [], 0, False
            piece.append(t); n += len(t); doubt = doubt or b
        if piece:
            out.append((label if first else None, "\n\n".join(piece),
                        path if first else None if doubt or not path else path + " (cont.)"))
        if notes and len(out) > at:
            l, t, pa = out[at]
            out[at] = (l, t + " " + " ".join(f"*{x}*" for x in notes), pa)
    for p in paras:
        t = p["text"].strip()
        m = OPENER.match(t)
        rejected = False
        if m:
            n = num_key(m[1])
            ok = n > last and (n[0] == last[0] if n[1] else
                               n[0] == last[0] + 1 or ((bool(p["note"]) or noteless) and n[0] <= last[0] + 10))
            if in_sched and not (ok and p["note"] and not n[1]):
                ok = False
            if not ok:
                m, rejected = None, not in_sched
            else:
                last, in_sched = n, False
        sched = bool(SCHED_HEAD.match(t.lstrip("#* ")) and "SCHEDULE" in t[:80] and len(t) < 120)
        hm = HEADING.match(t)
        heading = bool(hm) and not in_sched
        if parts and MID_PART.search(t):
            parts = head = None
        if heading and parts:
            kind, num = hm[1].title(), hm[2].upper()
            nm = re.fullmatch(r"(\d+)()|([IVXLC]+)([A-Z]?)", num)        # "II", "IIA", "XVIIA", "3" (a C suffix breaks the run)
            v = (int(nm[1]), "") if nm[1] else (roman(nm[3]), nm[4])
            prev = seen.get(kind)
            if (prev is None and v == (1, "")) or (prev and (v == (prev[0] + 1, "") or (v[0] == prev[0] and v[1] > prev[1]))):
                seen[kind] = v
                rest = re.sub(r"^[\s\-–—:.]+", "", t[hm.end():].replace("*", ""))
                title = re.sub(r"\s+", " ", rest.split("\n")[0]).strip()
                ok_title = title and len(title) <= 100 and not re.search(r"\d", title)
                head = f"{kind} {num}" + (f" — {title}" if ok_title else "")
            else:
                parts = head = None
        elif head and cur and not label and not m and not sched and len(cur) == 1 and HEADING.match(cur[0]) \
                and "—" not in head and len(t) <= 100 and not re.search(r"\d|\.$", t):
            head += " — " + re.sub(r"\s+", " ", t.replace("*", ""))   # the Part's title on the line after it
        if m or sched or heading:
            # a Part/Chapter heading leads the section after it: no chunk of headings alone
            if not (m and cur and label is None and HEADING.match(cur[0]) and all(len(x) < 150 for x in cur)):
                close()
                cur, bad, notes = [], [], []
            label = m[1] if m else (sched_name(t) or "Schedule") if sched else None
            in_sched = in_sched or sched
            if sched:
                head = None
            note = (p["note"] or "").strip("* ")
            whole = (note and len(note) <= 100 and note[0].isupper()          # not a fragment of a wrapped note:
                     and not re.search(r"\b(?:by|of|to|the|and|or|in|for|under|with|a|an|on|from)$", note.rstrip(" .,;"), re.I))
            what = (f"{word} {label}" + (f" — {note}" if whole else "")) if m else label
            path = " › ".join(x for x in ((None if sched else head), what) if x) or None
        cur.append(t)
        if p["note"]:
            notes.append(p["note"])
        bad.append(rejected)
    close()
    return [(l, t, pa) for l, t, pa in out if t.strip()]


def long_title_of(paras):
    return next((re.sub(r"^#+\s*|\*", "", p["text"]).strip() for p in paras[:40]
                 if re.match(r"^(?:#+\s*)?\**\s*AN?\s+(?:ACT|LAW|ORDINANCE)\s+(?:TO|FOR)\b", p["text"], re.I)), None)


def split_spreads(raw, lo):
    """A scan of two printed pages side by side (the 1978 Constitution, meta.spread): each image becomes two
    half-width pages, so blocks() finds one body column and its margin per printed page. A block goes to the half
    its centre is in; the cut is midway between the two halves' blocks (1978: left body ends ~472, right starts ~485)."""
    size = {p["page_no"]: (p["width_pt"], p["height_pt"]) for p in raw["pages"]}
    pages, out = [], []
    for p in sorted(lo["pages"], key=lambda p: p["page_no"]):
        bs = [(m, [int(x) for x in m.groups()[1:5]]) for m in BLOCK.finditer(p["md"])]
        left = [b for m, b in bs if m[1] not in DROP and (b[0] + b[2]) / 2 < 500]
        right = [b for m, b in bs if m[1] not in DROP and (b[0] + b[2]) / 2 >= 500]
        mid = (max((b[2] for b in left), default=480) + min((b[0] for b in right), default=480)) / 2
        w, h = size[p["page_no"]]
        for half, (lo_x, hi_x) in enumerate([(0, mid), (mid, 1000)]):
            sx = lambda x: str(round(min(1000, max(0, (x - lo_x) * 1000 / (hi_x - lo_x)))))
            md = "\n".join(f"![{m[1]}]({sx(b[0])},{b[1]},{sx(b[2])},{b[3]})\n{m[6]}" for m, b in bs
                           if ((b[0] + b[2]) / 2 < mid) == (half == 0))
            n = 2 * p["page_no"] - 1 + half
            pages.append({"page_no": n, "width_pt": w / 2, "height_pt": h, "chars": 0})
            out.append({**p, "page_no": n, "md": md})
    return {"pages": pages}, {**lo, "pages": out}


def text_of(raw, lo, le1980=False, spread=False):
    """(paragraphs, 'lighton' | 'html' | 'docling'). Every source goes through etl.structure.blocks(), which splits
    each page into body and margin by layout (the margin column moves page to page; LightOn returns a note as a
    plain block beside its section, often not italic: checked 2026-10-10 on 1,528 laws, an italic-only reading
    found notes on 48% of sections). LightOn's pages replace the others where it has them."""
    if spread and lo and lo.get("pages"):
        raw, lo = split_spreads(raw, lo)
    if lo and lo.get("pages"):
        raw = {**raw, "lighton": lo}
    src = "lighton" if lo and lo.get("pages") else "html" if raw.get("format") == "html" else "docling"
    paras = block_paras(blocks(raw, le1980=le1980))
    return (join_split(paras) if src == "lighton" else paras), src


KIND = {"act": "act", "law": "law", "ordinance": "ordinance", "cap": "chapter1980", "cap1956": "chapter1956",
        "amendment": "amendment", "constitution": "constitution", "other": "other"}
_w = {}


def _init():
    from etl import graph
    from etl.fetch import r2
    _w["conn"] = pg_connect()
    with _w["conn"], _w["conn"].cursor() as cur:       # chapter and Act titles, for names cited without a number
        graph.load_chapters(cur)
        refs.load_names(cur)
    _w["s3"], _w["bucket"] = r2(), os.environ["R2_BUCKET"]


def _get(k):
    return json.loads(gzip.decompress(_w["s3"].get_object(Bucket=_w["bucket"], Key=k)["Body"].read()))


def build_one(row):
    """One law: its file's raw (and LightOn pages) from R2 -> text -> chunks -> docs + chunks rows. The key, title
    and dates come from the law's `acts` row (etl.structure build: key rules, printed dates, commencement), which
    already picked the file to read (official copy first). -> (status, message)"""
    key, title, certified, commenced, comm, doc_id, sha, raw_key, meta = row
    try:
        raw = _get(raw_key)
        try:
            lo = _get(f"raw/lighton/{sha}.json.gz")
        except _w["s3"].exceptions.NoSuchKey:
            lo = None
        paras, src = text_of(raw, lo, le1980=bool(meta.get("cap")), spread=bool(meta.get("spread")))
        amending = "AMENDMENT" in (title or "").upper() and not key.startswith("constitution")
        ch = chunks(paras, "Article" if key.startswith("constitution") else "section", parts=not amending)
        if not ch:
            return "skip", f"skip {key}: no text"
        year = int(m[1]) if (m := re.search(r"/(\d{4})$", key)) else None
        conn = _w["conn"]
        lt = long_title_of(paras)
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM docs WHERE key = %s", (key,))
            cur.execute("""INSERT INTO docs (key, kind, title, year, certified, commenced, commencement, document_id,
                           text_from, built_with, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (key, KIND.get(key.split(":")[0], "other"), title, year, certified, commenced, Json(comm),
                         doc_id, src, BUILD, Json({"long_title": lt, "chunks": len(ch)})))
            ids = execute_values(cur, "INSERT INTO chunks (doc_key, seq, label, text, path) VALUES %s RETURNING id",
                                 [(key, i, l, t, pa) for i, (l, t, pa) in enumerate(ch)], page_size=1000, fetch=True)
            ids = [r[0] for r in ids]
            write_links(cur, key, lt, commenced, [t for _, t, _ in ch], ids)
        return "ok", ""
    except Exception as e:
        try:
            _w["conn"].rollback()
        except Exception:
            _w["conn"] = pg_connect()
        return "fail", f"FAIL {key}: {e}"[:300]


def build(keys=None, limit=None, workers=16):
    conn = pg_connect()
    cur = conn.cursor()
    cur.execute("""SELECT a.key, a.title, a.certified, a.commenced, a.commencement, a.document_id, d.sha256, d.raw_key, d.meta
                   FROM acts a JOIN documents d ON d.id = a.document_id
                   WHERE (%s::text[] IS NULL OR a.key = ANY(%s)) ORDER BY a.key LIMIT %s""", (keys, keys, limit))
    rows = cur.fetchall()
    conn.close()
    print(f"{len(rows)} documents to build", flush=True)
    n = {"ok": 0, "skip": 0, "fail": 0}
    with ProcessPoolExecutor(workers, initializer=_init) as ex:
        for i, (status, msg) in enumerate(ex.map(build_one, rows, chunksize=2), 1):
            n[status] += 1
            if msg:
                print(f"[{i}/{len(rows)}] {msg}", flush=True)
            if i % 100 == 0 or i == len(rows):
                print(f"[{i}/{len(rows)}] {n['ok']} built, {n['skip']} skipped, {n['fail']} failed", flush=True)
    links()


def write_links(cur, key, lt, commenced, texts, ids):
    """A law's links from its chunk texts (etl.refs: the text alone, no marginal notes), replacing the ones it had."""
    cur.execute("DELETE FROM links WHERE src_doc = %s AND detail IS NOT NULL", (key,))   # not the same_as copies from `edges`
    rows = [(key, None if i is None else ids[i], kind, dst, label, commenced, (ctx or "")[:300] or None, Json(det))
            for i, kind, dst, label, ctx, det in refs.links(key, lt, texts)]
    if rows:
        execute_values(cur, "INSERT INTO links (src_doc, src_chunk, kind, dst_doc, dst_label, date, context, detail) VALUES %s",
                       rows, page_size=1000)
    return len(rows)


def relink(keys=None):
    """Links again from the chunks in the database (no R2, no chunking): for a change to etl/refs.py. Reads chunk text
    out of the database, so only on ada's Postgres (Neon's transfer quota, 2026-10-10)."""
    from etl import graph
    conn = pg_connect()
    with conn.cursor() as cur:
        graph.load_chapters(cur)
        refs.load_names(cur)
        cur.execute("SELECT key, meta->>'long_title', commenced FROM docs WHERE %s::text[] IS NULL OR key = ANY(%s) ORDER BY key",
                    (keys, keys))
        docs = cur.fetchall()
    n = 0
    for j, (key, lt, commenced) in enumerate(docs, 1):
        with conn, conn.cursor() as cur:
            cur.execute("SELECT id, text FROM chunks WHERE doc_key = %s ORDER BY seq", (key,))
            rows = cur.fetchall()
            n += write_links(cur, key, lt, commenced, [t for _, t in rows], [i for i, _ in rows])
        if j % 500 == 0 or j == len(docs):
            print(f"[{j}/{len(docs)}] {n} links", flush=True)
    conn.close()
    links()


def links():
    """same_as pairs from the edition lists (etl.graph.link, kept in `edges`), and each link's target chunk: the
    target document's, or a same_as twin's, first chunk with the link's label. All inside the database: nothing
    is read out (Neon's transfer quota was hit on 2026-10-10)."""
    conn = pg_connect()
    with conn, conn.cursor() as cur:
        cur.execute("DELETE FROM links WHERE kind = 'same_as' AND detail IS NULL")      # the copies from `edges` (refs.py rows have detail)
        cur.execute("""INSERT INTO links (src_doc, kind, dst_doc, context)
                       SELECT DISTINCT e.src_act, 'same_as', e.dst_act, e.evidence FROM edges e
                       WHERE e.kind = 'same_as' AND e.new_text = 'link' AND e.src_act IN (SELECT key FROM docs)""")
        # a consolidated Constitution is the same document: "Article 154G" (13th Amendment) resolves in the text that has it
        cur.execute("""INSERT INTO links (src_doc, kind, dst_doc, context)
                       SELECT key, 'same_as', 'constitution', 'consolidated' FROM docs WHERE key LIKE 'constitution:%%'""")
        # every name of a document (same_as both ways; edges() records its own pairs as context "also <key>"),
        # then each link's candidate target documents, joined to chunks on the (doc_key, label) index. A correlated
        # alias lookup ran over 30 minutes on 19,330 links x 89,025 chunks (2026-10-10).
        cur.execute("""CREATE TEMP TABLE alias ON COMMIT DROP AS
                       SELECT DISTINCT a, b FROM (
                           SELECT src_doc a, dst_doc b FROM links WHERE kind = 'same_as' AND context NOT LIKE 'also %%'
                           UNION ALL SELECT dst_doc, src_doc FROM links WHERE kind = 'same_as' AND context NOT LIKE 'also %%'
                           UNION ALL SELECT dst_doc, substr(context, 6) FROM links WHERE kind = 'same_as' AND context LIKE 'also %%'
                           UNION ALL SELECT substr(context, 6), dst_doc FROM links WHERE kind = 'same_as' AND context LIKE 'also %%') x
                       WHERE a <> b""")
        cur.execute("CREATE INDEX ON alias (a)")
        # a repealed Part or Chapter: one repeals link per section under it (chunks.path), from the target document,
        # else from the first same_as twin that has that heading (issue #9: asOf(section) missed "Chapter XIX ... repealed")
        cur.execute("DELETE FROM links WHERE detail ? 'part'")
        cur.execute("""INSERT INTO links (src_doc, src_chunk, kind, dst_doc, dst_label, date, context, detail)
                       WITH hit AS (
                           SELECT l.id, x.doc, x.pref, c.label FROM links l
                           CROSS JOIN LATERAL (SELECT l.dst_doc doc, 0 pref UNION ALL SELECT b, 1 FROM alias WHERE a = l.dst_doc) x
                           JOIN chunks c ON c.doc_key = x.doc AND c.label IS NOT NULL
                                        AND (c.path = l.dst_label OR c.path LIKE l.dst_label || ' %%')
                           WHERE l.kind = 'repeals' AND l.dst_label ~ '^(Part|Chapter) [IVXL]+[A-Z]?$'),
                       best AS (SELECT DISTINCT ON (id) id, doc FROM hit ORDER BY id, pref, doc)
                       SELECT DISTINCT ON (l.id, h.label) l.src_doc, l.src_chunk, l.kind, h.doc, h.label, l.date, l.context,
                              l.detail || jsonb_build_object('part', l.dst_label)
                       FROM best b JOIN hit h ON h.id = b.id AND h.doc = b.doc JOIN links l ON l.id = b.id""")
        print(f"{cur.rowcount} section repeals from repealed Parts/Chapters", flush=True)
        cur.execute("""CREATE TEMP TABLE want ON COMMIT DROP AS
                       SELECT id, dst_doc doc, dst_label label, 0 pref FROM links WHERE dst_label IS NOT NULL
                       UNION ALL SELECT l.id, al.b, l.dst_label, 1 FROM links l JOIN alias al ON al.a = l.dst_doc
                       WHERE l.dst_label IS NOT NULL""")
        cur.execute("""UPDATE links l SET dst_chunk = t.cid FROM (
                           SELECT DISTINCT ON (w.id) w.id, c.id cid FROM want w
                           JOIN chunks c ON c.doc_key = w.doc AND c.label = w.label
                           ORDER BY w.id, w.pref, c.seq) t
                       WHERE l.id = t.id""")
        cur.execute("""SELECT count(*), count(*) FILTER (WHERE kind NOT IN ('cites','same_as')),
                              count(*) FILTER (WHERE dst_label IS NOT NULL), count(dst_chunk) FROM links""")
        t, change, labelled, resolved = cur.fetchone()
        print(f"{t} links: {change} changes, {labelled} name a part, {resolved} of those reach its chunk", flush=True)
    conn.close()


CITED = re.compile(r"(?:may|shall)\s+be\s+cited\s+as\s+(?:the\s+)?([^.*\n]{3,160}?)\b(Act|Law|Ordinance)\W{0,3}No[.,:]?\s*(\d+)\s*(?:of|0f)\s*(\d{4})",
                   re.I | re.S)


def key_plan(cur, tried):
    """[(key, "typo" | "switch" | "drop", other document id, why)] for each Act/Law printing another number."""
    import difflib
    from etl.graph import norm_name
    cur.execute("""SELECT d.key, d.document_id, coalesce(nullif(trim(x.title), ''), d.title), x.meta->>'act_no', (SELECT string_agg(text, ' ' ORDER BY seq)
                   FROM chunks WHERE doc_key = d.key AND seq < 3) FROM docs d JOIN documents x ON x.id = d.document_id
                   WHERE d.key ~ '^(act|law):'""")
    rows = cur.fetchall()
    held = {r[0] for r in rows}

    def text(k):
        cur.execute("SELECT string_agg(text, ' ' ORDER BY seq) FROM chunks WHERE doc_key = %s", (k,))
        return re.sub(r"\s+", " ", cur.fetchone()[0] or "")[:6000]
    plan = []
    for key, doc_id, listed, act_no, head in rows:
        if not (m := CITED.search(head or "")) or (printed := refs.num_key(m[2], m[3], m[4])) == key:
            continue
        a, b = norm_name(m[1] + m[2]), norm_name(re.sub(r",?\s*No\.?\s*\d+.*$", "", listed or ""))
        same_name = difflib.SequenceMatcher(None, a, b).ratio() >= 0.85      # listings misspell ("Universitites")
        dup = printed in held and difflib.SequenceMatcher(None, text(key), text(printed), autojunk=False).ratio() >= 0.95
        said = re.sub(r"\s+", " ", m[0])[-80:]
        why = f"prints {said!r}, listed as {listed!r}" + (f", same text as {printed}" if dup else "")
        if same_name and not dup:
            plan.append((key, "typo", None, why))
            continue
        tried.setdefault(key, set()).add(doc_id)
        cur.execute("""SELECT id, raw_key IS NOT NULL FROM documents WHERE meta->>'act_no' = %s AND id <> ALL(%s) AND r2_key IS NOT NULL
                       AND sha256 <> ALL(SELECT sha256 FROM documents WHERE id = ANY(%s) AND sha256 IS NOT NULL)
                       AND coalesce(meta->>'lang', 'ENGLISH') ILIKE 'english%%' ORDER BY raw_key IS NOT NULL DESC, source = 'parliament' DESC, id""",
                    (act_no, list(tried[key]), list(tried[key])))
        alt = cur.fetchone()
        plan.append((key, "drop" if not alt else "switch" if alt[1] else "extract", alt and alt[0], why))
    return plan


def keys(fix=False):
    """Each Act/Law's own "may be cited as ... No. N of YYYY" against its key (2026-10-11: 35 of 3,959 differ).
    The printed name is the listing's title -> the key is right, the printed number a misprint (kept), unless the
    text is that of the law the printed number is held as (a duplicate file). Otherwise the file is another law:
    switch to another listing row of the same number that has a file and rebuild, until one prints its key; with
    none left, drop the document (its chunks and links go with it) and say why on its `documents` row."""
    conn = pg_connect()
    tried = {}
    while True:
        with conn.cursor() as cur:
            plan = key_plan(cur, tried)
        for k, act, alt, why in plan:
            print(k, act + (f" to document {alt}" if alt else ""), why, sep=" | ", flush=True)
        # "extract": the other file is fetched but not extracted; etl.extract first (on ada), then run this again
        if not fix or not (sw := [(k, alt) for k, act, alt, _ in plan if act == "switch"]):
            break
        with conn, conn.cursor() as cur:
            for k, alt in sw:
                cur.execute("UPDATE acts SET document_id = %s, title = (SELECT title FROM documents WHERE id = %s) WHERE key = %s",
                            (alt, alt, k))
        build([k for k, _ in sw], workers=2)
    for k, act, _, why in plan if fix else []:
        if act == "drop":
            with conn, conn.cursor() as cur:
                cur.execute("UPDATE documents SET error = %s WHERE id = (SELECT document_id FROM acts WHERE key = %s)",
                            (f"wrong file for {k}: {why}"[:500], k))
                cur.execute("DELETE FROM docs WHERE key = %s", (k,))
                cur.execute("DELETE FROM acts WHERE key = %s", (k,))
            print("dropped", k, flush=True)
    conn.close()


def gold(path="etl/gold_links.json"):
    """The hand-labelled links (issue #9, 210 sampled by kind 2026-10-20) against the links table: each one's right
    target (and section) is there, and a wrong target it once had is gone. Link ids change on every relink, so a link
    is matched by source law, kind, target and label."""
    conn = pg_connect()
    cur = conn.cursor()
    n, bad = {}, []
    for g in json.load(open(path)):
        cur.execute("SELECT 1 FROM links WHERE src_doc = %s AND kind = %s AND dst_doc = ANY(%s) AND dst_label IS NOT DISTINCT FROM %s",
                    (g["src"], g["kind"], g["dst"], g["label"]))
        ok = cur.fetchone() is not None
        if ok and g.get("was"):
            cur.execute("SELECT 1 FROM links WHERE src_doc = %s AND kind = %s AND dst_doc = %s AND dst_label IS NOT DISTINCT FROM %s",
                        (g["src"], g["kind"], *g["was"]))
            ok = cur.fetchone() is None
        t = n.setdefault(g["kind"], [0, 0])
        t[0] += ok; t[1] += 1
        if not ok:
            bad.append(g)
    for k, (ok, all_) in sorted(n.items()):
        print(f"{k:13} {ok}/{all_}")
    print(f"total {sum(v[0] for v in n.values())}/{sum(v[1] for v in n.values())}")
    for g in bad:
        print("MISS", g["src"], g["kind"], g["dst"], g["label"], "|", (g.get("note") or g["context"] or "")[:120])
    conn.close()


def show(key):
    conn = pg_connect()
    cur = conn.cursor()
    cur.execute("SELECT seq, label, path, text FROM chunks WHERE doc_key = %s ORDER BY seq", (key,))
    for seq, label, path, text in cur.fetchall():
        print(f"--- [{seq}] {label or ''}  {path or ''}\n{text[:400]}")
    conn.close()


def main():
    a = argparse.ArgumentParser()
    sub = a.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="raw (R2) -> docs + chunks, then links")
    b.add_argument("--keys", help="comma-separated keys (default: every law in `acts`)")
    b.add_argument("--limit", type=int)
    b.add_argument("--workers", type=int, default=16)
    sub.add_parser("links", help="resolve link targets to chunks (inside the database)")
    r = sub.add_parser("relink", help="links again from the chunks in the database (etl/refs.py), then resolve")
    r.add_argument("--keys", help="comma-separated keys (default: every document)")
    k = sub.add_parser("keys", help="Acts/Laws whose short title prints another number: report; --fix switches or drops")
    k.add_argument("--fix", action="store_true")
    sub.add_parser("gold", help="the hand-labelled links (etl/gold_links.json) against the links table")
    s = sub.add_parser("show")
    s.add_argument("key")
    args = a.parse_args()
    if args.cmd == "build":
        build(args.keys.split(",") if args.keys else None, args.limit, args.workers)
    elif args.cmd == "links":
        links()
    elif args.cmd == "keys":
        keys(args.fix)
    elif args.cmd == "gold":
        gold()
    elif args.cmd == "relink":
        relink(args.keys.split(",") if args.keys else None)
    else:
        show(args.key)


if __name__ == "__main__":
    main()
