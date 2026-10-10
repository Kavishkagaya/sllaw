#!/usr/bin/env python3
"""Documents, their text in chunks, and links between documents (Neon `docs`, `chunks`, `links`; migration 003).

  python3 -m etl.docs build [--keys act:12/2002,...] [--limit N]   # raw (R2) -> docs + chunks, then links
  python3 -m etl.docs show act:12/2002                             # print a document's chunks (no writes)

No section/schedule assembly (decision 2026-10-10, user). A document's text is read in reading order:
  PDFs   LightOnOCR-3's page markdown (raw/lighton, etl.ocr): blocks `![label](x0,y0,x1,y1) text` on a 0-1000 grid.
         Marginal notes come as an italic tail on the section's block ("1. This Act may be cited as ... *Short
         title.*"), or as their own block in the margin column (italic `text`, or `aside_text`); a note block goes
         onto the body block level with it. Page furniture (header, page_number, footer, image, text+) is dropped.
  HTML   the same form, from etl.structure.blocks() (body and margin cells of the 1956 edition, lankalaw, CommonLII).
The text is cut into chunks at section openers ("22. ...", "12A. ...") and at Part / Chapter / Schedule headings;
a chunk's label is what it opens, in the form links use ("22", "First Schedule"). Links come from
etl.graph.edges() run over the chunks (sections = chunks with a label).
"""
import argparse, gzip, html, json, os, re
from concurrent.futures import ProcessPoolExecutor

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl.fetch import pg_connect
from etl.structure import QUOTES, SCHED_HEAD, act_key, blocks, commencement, parse_date, sched_name

load_dotenv()
BUILD = "2026-10-10"
BLOCK = re.compile(r"!\[([\w+-]+)\]\((\d+),(\d+),(\d+),(\d+)\)[ \t]*\n?(.*?)(?=\n!\[[\w+-]+\]\(\d|\Z)", re.S)
DROP = {"header", "page_number", "footer", "image", "footer_image", "text+", "page_footer", "page_header"}
OPENER = re.compile(r"^(\d{1,3}[A-Z]{0,4})\s*\.\s+\S")        # "22. (1) The ...", "12A. Where ..."; not "“25A." (quoted)
HEADING = re.compile(r"^(?:#+\s*)?\**\s*(PART|CHAPTER)\s+([IVXLC]+[A-Z]?|\d+)\b", re.I)
MAX = 3000                                                    # chars; a longer chunk is cut at paragraph ends


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


def num_key(n):
    m = re.match(r"(\d+)([A-Z]*)", n)
    return int(m[1]), m[2]


def chunks(paras):
    """Paragraphs -> [(label, text)]: a new chunk at each section opener and each Part/Chapter/Schedule heading;
    a section's note follows its first line as an italic tail, the form LightOn prints. Over MAX, cut at a
    paragraph end (the label stays on the first piece).
    A numbered paragraph opens a section only if it continues the sequence: the next number, a lettered one of
    the same base (12 -> 12A), or a jump of up to 10 with its own note (numbers lost to OCR). After a schedule
    heading, numbered items are the schedule's ("1. Name of applicant"), until the next section number appears
    with a note (1980 chapters print schedules between sections). On 1,528 LightOn laws, openers without this
    rule went backwards 1,570 times (2026-10-10)."""
    out, cur, label, last, in_sched = [], [], None, (0, ""), False
    def close():
        piece, n, first = [], 0, True
        for t in cur:
            if piece and n + len(t) > MAX:
                out.append((label if first else None, "\n\n".join(piece)))
                piece, n, first = [], 0, False
            piece.append(t); n += len(t)
        if piece:
            out.append((label if first else None, "\n\n".join(piece)))
    for p in paras:
        t = p["text"].strip()
        m = OPENER.match(t)
        if m:
            n = num_key(m[1])
            ok = n > last and (n[0] == last[0] if n[1] else
                               n[0] == last[0] + 1 or (bool(p["note"]) and n[0] <= last[0] + 10))
            if in_sched and not (ok and p["note"] and not n[1]):
                ok = False
            if not ok:
                m = None
            else:
                last, in_sched = n, False
        sched = bool(SCHED_HEAD.match(t.lstrip("#* ")) and "SCHEDULE" in t[:80] and len(t) < 120)
        head = bool(HEADING.match(t)) and not in_sched
        if m or sched or head:
            # a Part/Chapter heading leads the section after it: no chunk of headings alone
            if not (m and cur and label is None and HEADING.match(cur[0]) and all(len(x) < 150 for x in cur)):
                close()
                cur = []
            label = m[1] if m else (sched_name(t) or "Schedule") if sched else None
            in_sched = in_sched or sched
        cur.append(t + (f" *{p['note']}*" if p["note"] else ""))
    close()
    return [(l, t) for l, t in out if t.strip()]


def as_doc(ch, long_title):
    """The shape etl.graph.edges() and etl.structure.commencement() read: chunks with a section label as
    sections (note = the italic tail of the first line; quoted paragraphs flagged)."""
    secs = []
    for label, text in ch:
        if not label or not re.match(r"\d", label):
            continue
        paras = text.split("\n\n")
        paras = paras[next((i for i, t in enumerate(paras) if OPENER.match(t)), 0):]   # after any Part/Chapter heading
        first = paras[0]
        m = re.search(r"\s\*([^*]{3,200})\*\s*$", first)
        note = m[1].strip() if m else None
        if m:
            paras[0] = first[:m.start()]
        paras[0] = re.sub(r"^\d{1,3}[A-Z]{0,4}\s*\.\s+", "", paras[0])
        secs.append({"num": label, "note": note,
                     "paras": [{"label": None, "text": t, "quoted": t.lstrip()[:1] in QUOTES} for t in paras]})
    return {"long_title": long_title or "", "sections": secs}


def long_title_of(paras):
    return next((re.sub(r"^#+\s*|\*", "", p["text"]).strip() for p in paras[:40]
                 if re.match(r"^(?:#+\s*)?\**\s*AN?\s+(?:ACT|LAW|ORDINANCE)\s+(?:TO|FOR)\b", p["text"], re.I)), None)


def text_of(raw, lo, le1980=False):
    """(paragraphs, 'lighton' | 'html' | 'docling'). Every source goes through etl.structure.blocks(), which splits
    each page into body and margin by layout (the margin column moves page to page; LightOn returns a note as a
    plain block beside its section, often not italic: checked 2026-10-10 on 1,528 laws, an italic-only reading
    found notes on 48% of sections). LightOn's pages replace the others where it has them."""
    if lo and lo.get("pages"):
        raw = {**raw, "lighton": lo}
    src = "lighton" if lo and lo.get("pages") else "html" if raw.get("format") == "html" else "docling"
    return block_paras(blocks(raw, le1980=le1980)), src


KIND = {"act": "act", "law": "law", "ordinance": "ordinance", "cap": "chapter1980", "cap1956": "chapter1956",
        "amendment": "amendment", "other": "other"}
_w = {}


def _init():
    from etl import graph
    from etl.fetch import r2
    _w["conn"] = pg_connect()
    with _w["conn"], _w["conn"].cursor() as cur:       # chapter and Act titles, for names cited without a number
        graph.load_chapters(cur)
    _w["edges"] = graph.edges
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
        paras, src = text_of(raw, lo, le1980=bool(meta.get("cap")))
        ch = chunks(paras)
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
            ids = execute_values(cur, "INSERT INTO chunks (doc_key, seq, label, text) VALUES %s RETURNING id",
                                 [(key, i, l, t) for i, (l, t) in enumerate(ch)], page_size=1000, fetch=True)
            ids = [r[0] for r in ids]
            by_label = {}
            for (l, _), cid in zip(ch, ids):
                if l:
                    by_label.setdefault(l, cid)
            rows = []
            for e in _w["edges"](as_doc(ch, lt), key, commenced):
                kind, dst, dst_label, evidence = e[2], e[3], e[4], e[7]
                src_chunk = None if kind == "same_as" else (by_label.get(e[1]) if e[1] else ids[0])
                rows.append((key, src_chunk, kind, dst, dst_label, e[5], (evidence or "")[:300] or None))
            if rows:
                execute_values(cur, "INSERT INTO links (src_doc, src_chunk, kind, dst_doc, dst_label, date, context) VALUES %s",
                               rows, page_size=1000)
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


def links():
    """same_as pairs from the edition lists (etl.graph.link, kept in `edges`), and each link's target chunk: the
    target document's, or a same_as twin's, first chunk with the link's label. All inside the database: nothing
    is read out (Neon's transfer quota was hit on 2026-10-10)."""
    conn = pg_connect()
    with conn, conn.cursor() as cur:
        cur.execute("DELETE FROM links WHERE kind = 'same_as' AND src_chunk IS NULL AND context NOT LIKE 'also %%'")
        cur.execute("""INSERT INTO links (src_doc, kind, dst_doc, context)
                       SELECT DISTINCT e.src_act, 'same_as', e.dst_act, e.evidence FROM edges e
                       WHERE e.kind = 'same_as' AND e.new_text = 'link' AND e.src_act IN (SELECT key FROM docs)""")
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


def show(key):
    conn = pg_connect()
    cur = conn.cursor()
    cur.execute("SELECT seq, label, text FROM chunks WHERE doc_key = %s ORDER BY seq", (key,))
    for seq, label, text in cur.fetchall():
        print(f"--- [{seq}] {label or ''}\n{text[:400]}")
    conn.close()


def main():
    a = argparse.ArgumentParser()
    sub = a.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="raw (R2) -> docs + chunks, then links")
    b.add_argument("--keys", help="comma-separated keys (default: every law in `acts`)")
    b.add_argument("--limit", type=int)
    b.add_argument("--workers", type=int, default=16)
    sub.add_parser("links", help="links again from the chunks in Neon (no R2)")
    s = sub.add_parser("show")
    s.add_argument("key")
    args = a.parse_args()
    if args.cmd == "build":
        build(args.keys.split(",") if args.keys else None, args.limit, args.workers)
    elif args.cmd == "links":
        links()
    else:
        show(args.key)


if __name__ == "__main__":
    main()
