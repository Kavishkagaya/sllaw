#!/usr/bin/env python3
"""Step 4: structured English Acts + the amendment graph in Neon, and the post-retrieval walk.

  python3 -m etl.graph build [--limit N] [--full]   # new/changed English Acts -> acts, sections, edges
  python3 -m etl.graph walk 14/2002 22 --year 2023  # a section as it stood: original + changes up to then
  python3 -m etl.graph missing                      # targets edges point at that are not built, and why

Edges are read from text the structure step already isolates, not guessed:
  amends_act / repeals_act   long title "AN ACT TO AMEND THE ... ACT, NO. 14 OF 2002"
  amends | replaces | repeals | inserts
                             marginal note "Amendment of section 22 of Act, No. 14 of 2002" /
                             "... of the principal enactment" (defined once, "hereinafter referred to
                             as the 'principal enactment'"); new_text = the section's quoted paragraphs
  repeals_act                a section whose note says Repeal without naming a section
  cites                      "Act, No. 19 of 1994", "(Chapter 26)" in this Act's own (unquoted) text
  same_as                    one law under two keys, act:44/1953 = cap:432 (its 1980 Revised Edition chapter)
The walk is for retrieval: it doesn't apply amendments, it lists them in date order so the
reader (an LLM) gets the original wording plus every later change up to the year asked.
"""
import argparse, gzip, json, os, re
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl.fetch import r2
from etl.structure import act, blocks

load_dotenv()
# Bump when etl/structure.py or the edge rules change, so `build` redoes every Act; otherwise it only
# builds Acts that are new or were re-extracted (their raw_key or extracted_at changed).
BUILD = "2026-10-09.5"  # 07: Surya text, non-English skipped, printed date = year; 09: LightOn pages (old if better), notes, openers
CIT = re.compile(r"\b(Act|Law|Ordinance),?\s*No\.?\s*(\d+)\s+of\s+(\d{4})", re.I)
CHAP = re.compile(r"\b(?:Chapter|Cap\.?)\s*(\d+[A-Z]?)\b")        # digits only: this Act's own CHAPTERs are roman
NOTE = re.compile(r"^(Amendment|Replacement|Substitution|Repeal|Insertion|Addition)s?\b(.*)$", re.I)
KIND = {"amendment": "amends", "replacement": "replaces", "substitution": "replaces",
        "repeal": "repeals", "insertion": "inserts", "addition": "inserts"}


ORDINAL = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth".split()


def sched_name(t):
    """'FIRST SCHEDULE', 'the First Schedule', 'SCHEDULE A (Section 2)', 'SCHEDULE' -> 'First Schedule',
    'Schedule A', 'Schedule': the same name for a schedule's own row and for edges pointing at it."""
    m = re.search(rf"\b(?:({'|'.join(ORDINAL)})\s+)?(SCHEDULES?)\b(?:\s+(?!(?:in|to|of|the|and)\b)([A-Z0-9]{{1,3}})\b(?!\s*\())?",
                  t, re.I)
    if not m:
        return None
    if m[1]:
        return f"{m[1].title()} Schedule"
    if m[2].lower() == "schedules":
        return "Schedules"                                 # "Repeal of Schedules" = all of them
    return f"Schedule {m[3].upper()}" if m[3] else "Schedule"


# "Chapter N" is ambiguous: later Acts cite pre-1980 law by its 1956 Revised Edition chapter as often as by
# its 1980 one ("section 53 of the Penal Code (Chapter 19)", 10/2018; Chapter 19 in 1980 is Courts' Records).
# The law's name is not ambiguous, so a chapter citation resolves by the name printed before it.
CHAPTERS = {}            # normalised 1980 chapter title -> its acts key; loaded per worker (load_chapters)
_cite = {"local": {}, "le": False}   # per Act being built: chapter number -> key resolved by name; in a 1980 chapter?


def norm_name(t):
    """'the Masters Attendant Ordinance', 'MASTERS ATTENDANT*', 'Penal Code (Chapter 25)' -> 'masters attendant',
    'penal code'."""
    t = re.sub(r"\((?:chapter|cap)[^)]*\)?", " ", t.lower())
    w = re.sub(r"[^a-z ]", " ", t.replace("’", "'").replace("'s", "s")).split()
    while w and w[0] == "the":
        w = w[1:]
    while w and w[-1] in ("ordinance", "act", "law", "enactment"):
        w = w[:-1]
    return " ".join(w)


def load_chapters(cur):
    """Names of the built 1980 chapters: the title the PDF prints and lankalaw's. A name two chapters share
    is dropped (it can't decide anything)."""
    cur.execute("SELECT a.key, a.title, d.title FROM acts a JOIN documents d ON d.id = a.document_id "
                "WHERE d.source = 'le1980'")
    seen = {}
    for k, *names in cur.fetchall():
        for n in {norm_name(x) for x in names if x} - {""}:
            seen.setdefault(n, set()).add(k)
    CHAPTERS.clear()
    CHAPTERS.update({n: next(iter(ks)) for n, ks in seen.items() if len(ks) == 1})


def chapter_by_name(m):
    """The chapter whose title ends the text just before "(Chapter N)", longest name first; None if none."""
    words = re.findall(r"[A-Za-z’'-]+", m.string[max(0, m.start() - 160):m.start()])
    for k in range(min(12, len(words)), 0, -1):
        if (hit := CHAPTERS.get(norm_name(" ".join(words[-k:])))):
            return hit
    return None


def key_of(m):
    """A citation match -> node key: act:14/2002, law:1/1975, ordinance:5/1950, cap:107 (a 1980 chapter),
    chapter:19 (a chapter number whose law isn't named, so the edition is unknown)."""
    if m.re is CHAP:
        return (chapter_by_name(m) or _cite["local"].get(m[1])
                or (f"cap:{m[1]}" if _cite["le"] else f"chapter:{m[1]}"))   # in a 1980 chapter: 1980 numbers
    return f"{m[1].lower()}:{int(m[2])}/{m[3]}"


def first_target(text):
    hits = sorted([m for r in (CIT, CHAP) for m in r.finditer(text or "")], key=lambda m: m.start())
    return key_of(hits[0]) if hits else None


def text_of(s, quoted=None):
    return "\n".join(((p["label"] + " ") if p["label"] else "") + p["text"] for p in s["paras"]
                     if quoted is None or bool(p.get("quoted")) == quoted)


def provisions(doc, key):
    """Rows for `sections`: the preamble, every section, every schedule, in the Act's order."""
    head = lambda h, word: h and " ".join(filter(None, [word, h["num"], h["title"]]))
    rows = []
    pre = "\n".join(filter(None, [doc["long_title"], *doc["preamble"], doc["enacting"]]))
    if pre:
        rows.append(("Preamble", "preamble", None, None, None, None, pre))
    for s in doc["sections"]:
        rows.append((s["num"], "section", s["note"], head(s["part"], "PART"), head(s["chapter"], "CHAPTER"),
                     s.get("heading"), text_of(s)))
    seen = set()
    for sc in doc["schedules"]:
        name = sched_name(sc["heading"] or "") or "Schedule"
        n, i = name, 2
        while n in seen:                           # two headings both read "SCHEDULE"
            n, i = f"{name} ({i})", i + 1
        seen.add(n)
        # "[Section 41]", "(sections 5, 6 and 9)", "section 3(1)": the sections the schedule belongs to
        ref = next((p["text"] for p in sc["paras"][:2]
                    if re.fullmatch(r"[\[(]?\s*sections?\s+[\w(), ]{1,40}[\])]?\.?", p["text"].strip(), re.I)), None)
        body = "\n".join("\n".join(" | ".join(c for c in r if c) for r in p["rows"]) if p.get("rows") else p["text"]
                         for p in sc["paras"])
        rows.append((n, "schedule", ref, None, None, None, "\n".join(filter(None, [sc["heading"], body]))))
    return [(key, num, kind, i, *rest) for i, (num, kind, *rest) in enumerate(rows)]


def edges(doc, key, date):
    out = []
    lt = doc["long_title"] or ""
    # a bare "Chapter 19" means the law this Act names as Chapter 19 elsewhere ("the Penal Code (Chapter 19)")
    _cite["le"], _cite["local"] = key.startswith("cap:"), {}
    for m in CHAP.finditer(" ".join([lt] + [text_of(s) for s in doc["sections"]])):
        if m[1] not in _cite["local"] and (hit := chapter_by_name(m)):
            _cite["local"][m[1]] = hit
    lt_target = first_target(lt)
    if lt_target and re.match(r"AN\s+ACT\s+TO\s+(AMEND|REPEAL|PROVIDE FOR THE REPEAL)", lt, re.I):
        kind = "repeals_act" if re.search(r"\bREPEAL\b", lt[:40], re.I) and "AMEND" not in lt[:20].upper() else "amends_act"
        for t in dict.fromkeys(key_of(x) for r in (CIT, CHAP) for x in r.finditer(lt)):   # all laws it names
            out.append((None, kind, t, None, None, lt))
    principal = None
    for s in doc["sections"]:
        own = text_of(s, quoted=False)
        if not principal and (m := re.search(r"referred to as (?:the\s+)?['‘’\"“”]{1,2}(?:the\s+)?principal (?:enactment|Act|Law)", own)):
            # the law named just before the phrase, skipping "... as last amended by Act, No. 24 of 1999",
            # which names an amending Act, not the principal one (6 wrong aliases on the first Neon build)
            before = sorted([x for r in (CIT, CHAP) for x in r.finditer(own[:m.start()])
                             if not re.search(r"amended\s+by\s*(?:the\s+)?$", own[max(0, x.start() - 40):x.start()], re.I)],
                            key=lambda x: x.start())
            principal = key_of(before[-1]) if before else None
        note = s["note"] or ""
        if (m := NOTE.match(note.strip())):
            rest = m[2]
            # a note without its own target means the principal enactment ("Replacement of Form F of
            # the Second Schedule", 47/2011)
            target = first_target(rest) or principal or lt_target
            # what is changed: "section 22", "sections 12A, 12B and 12C", "the First Schedule"
            sm = re.search(r"\bsections?\s*((?:\d+[A-Z]*)(?:\s*(?:,|and|to)\s*\d+[A-Z]*)*)", rest, re.I)  # "sections12A" (9/2018)
            sched = sched_name(rest)
            kind = KIND[m[1].lower()]
            if kind == "repeals" and re.search(r"replace|substitut", rest, re.I):
                kind = "replaces"
            new = text_of(s, quoted=True) or None
            if target and sm:
                for n in re.findall(r"\d+[A-Za-z]*", sm[1]):       # "161c" (8/2022)
                    n = n.upper()
                    out.append((s["num"], kind, target, n, new, note))
            elif target and sched:
                out.append((s["num"], kind, target, sched, new, note))
            elif kind == "repeals":                           # "Repeal and savings": the laws its text names
                for t in {key_of(x) for r in (CIT, CHAP) for x in r.finditer(own)} - {key}:
                    out.append((s["num"], "repeals_act", t, None, None, note))
            elif target:
                out.append((s["num"], kind, target, None, new, note))
        for t in {key_of(x) for r in (CIT, CHAP) for x in r.finditer(own)} - {key}:
            out.append((s["num"], "cites", t, None, None, None))
    # one law, two names: "Act, No. 44 of 1953 (Chapter 432)" side by side, or a long title naming a
    # single law that the principal enactment calls by its 1980 chapter (32/2008)
    text = lt + " " + " ".join(text_of(s, quoted=False) for s in doc["sections"][:3])
    pairs = {(key_of(a), key_of(b)) for a in CIT.finditer(text) for b in CHAP.finditer(text)
             if 0 <= b.start() - a.end() <= 12}
    lt_all = {key_of(x) for r in (CIT, CHAP) for x in r.finditer(lt)}
    # ...only if the long title names one law in words too: 21/2012 amends two Ordinances named
    # without numbers and Act 15/1987, which is not Chapter 252
    named = len(re.findall(r"\b(?:ACT|ORDINANCE|LAW)\b", re.sub(r"^AN\s+ACT\b", "", lt, flags=re.I), re.I))
    if principal and len(lt_all) == 1 and named == 1 and principal not in lt_all:
        pairs.add((next(iter(lt_all)), principal))
    out += [(None, "same_as", a, None, None, f"also {b}") for a, b in pairs if a != b]
    return [(key, *e[:4], date, *e[4:]) for e in out]          # date: the Act's commencement


MONTHS = {m: i for i, m in enumerate("january february march april may june july august september "
                                     "october november december".split(), 1)}


def parse_date(t):
    """'January 1, 2011' | '1st January, 2011' | 'the 1st day of April, 2011' -> '2011-01-01'."""
    mon = "|".join(MONTHS)
    for pat, order in ((rf"({mon})\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})", "mdy"),
                       # "8th September. 1948." (1980 Revised Edition OCR: a full stop for the comma)
                       (rf"(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?({mon})[,.]?\s+(\d{{4}})", "dmy")):
        if (m := re.search(pat, t, re.I)):
            mo, d, y = (m[1], m[2], m[3]) if order == "mdy" else (m[2], m[1], m[3])
            return f"{y}-{MONTHS[mo.lower()]:02d}-{int(d):02d}"
    return None


def commencement(doc, certified):
    """When the whole Act came into force, from s.1 or a section noted 'date of operation' /
    'commencement' / 'retrospective'. Only the Act-wide sentence counts, not provisos for parts.
    -> (date the walk uses, {kind, text}). kind: date | deemed (retrospective) | certified
    (Speaker's certificate) | appointed (by a Gazette Order, not in the corpus) | unstated."""
    cands = doc["sections"][:1] + [s for s in doc["sections"][1:]
                                    if re.search(r"operation|commence|retrospect", s["note"] or "", re.I)]
    for s in cands:
        text = " ".join(p["text"] for p in s["paras"] if not p.get("quoted"))
        m = re.search(r"(?:this Act|provisions of this Act(?:,? other than this section)?)(?:[^.;:]|\bNo\.){0,120}?"
                      r"shall\s+(be\s+deemed\s+to\s+have\s+)?come\s+into\s+(?:operation|force)\s+"
                      r"(?:on|from|with\s+effect\s+from)\s+([^.;:]{0,140})", text, re.I)
        if not m:
            continue
        sentence, tail = m[0], m[2]
        if re.match(r"(?:such\s+)?date\s+as\s+the\s+Minister|such\s+date", tail, re.I):
            return certified, {"kind": "appointed", "text": sentence}
        if re.match(r"the\s+date\s+on\s+which\s+the\s+certificate", tail, re.I):
            return certified, {"kind": "certified", "text": sentence}
        if (d := parse_date(tail)):
            return d, {"kind": "deemed" if m[1] else "date", "text": sentence}
    return certified, {"kind": "unstated", "text": None}


def act_key(meta, doc=None):
    if meta.get("cap"):
        # Legislative Enactments 1980 chapter: the number the PDF prints, else lankalaw's listing
        # (which lists both Customs and Masters Attendant as 235, 2026-10-07)
        return f"cap:{(doc or {}).get('cap') or meta['cap']}"
    if meta.get("cap1956"):
        return f"cap1956:{meta['cap1956']}"       # 1956 Revised Edition chapter (other numbers than 1980's)
    no = meta.get("act_no") or ""
    if meta.get("kind") in ("law", "ordinance") and re.fullmatch(r"[1-9]\d*/\d{4}", no):
        return f"{meta['kind']}:{no}"             # CommonLII says which (law:19/1978 beside act:19/1978)
    if re.fullmatch(r"[1-9]\d*/\d{4}", no):
        # 1972-78 National State Assembly Laws: lankalaw lists them by number like Acts, amending Acts
        # cite them as "Law No. 5 of 1972" (law:5/1972); the file says which it is
        if 1972 <= int(no[-4:]) <= 1978 and re.search(r"\bLAW\b,?\s*No", (doc or {}).get("title") or ""):
            return f"law:{no}"
        return f"act:{no}"
    return f"other:{meta['listing']['id']}"       # 0/YYYY = Constitution amendments, several per year


_w = {}


def _init(local):
    """One per worker process: its own Neon connection and R2 client (or local raw files)."""
    _w["conn"] = psycopg2.connect(os.environ["DATABASE_URL"])
    if local:
        files = {json.load(gzip.open(f))["sha256"]: f for f in Path(local).glob("*.json.gz")}
        _w["load"] = lambda sha, _: json.load(gzip.open(files[sha]))
    else:
        s3, bucket = r2(), os.environ["R2_BUCKET"]
        get = lambda k: json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=k)["Body"].read()))

        def load(sha, k):
            """raw/v2 plus, for scans, LightOnOCR-3's pages (raw/lighton, etl.ocr) when they exist."""
            raw = get(k)
            try:
                raw["lighton"] = get(f"raw/lighton/{sha}.json.gz")
            except s3.exceptions.NoSuchKey:
                pass
            return raw
        _w["load"] = load
    with _w["conn"], _w["conn"].cursor() as cur:   # ponytail: chapters built before this run; new ones resolve on the next
        load_chapters(cur)


def gaps(doc):
    """Section numbers missing between 1 and the highest one found."""
    nums = {int(s["num"]) for s in doc["sections"] if s["num"].isdigit()}
    return sum(1 for i in range(1, max(nums, default=0) + 1) if i not in nums)


def structure(raw, le1980=False):
    """The Act from LightOnOCR-3's pages where it has them, unless the old engine's pages (Chandra or
    Surya) give more sections with no more numbering gaps. On the full build of 2026-10-09 LightOn gave
    169 pre-2000 Acts more sections and 52 fewer: a separately boxed note inside quoted text (50/1981)
    can put a scanned page's margin on the wrong side, and some noisy pages read worse (21/1981)."""
    doc = act(blocks(raw, le1980=le1980))
    if raw.get("lighton") and not le1980:
        old = act(blocks({k: v for k, v in raw.items() if k != "lighton"}))
        if len(old["sections"]) > len(doc["sections"]) and gaps(old) <= gaps(doc):
            return {**old, "ocr": "old"}
        doc["ocr"] = "lighton"
    return doc


def build_one(row):
    """Read the raw into memory, structure it, write the Act, its provisions and edges; nothing goes
    to disk. Each worker process does the whole Act: the build waits on R2 and Neon round trips
    (us-east-1), not on CPU, so Acts go in parallel (one process, serial writes: 27 Acts/min,
    2026-10-07). -> ("ok" | "skip" | "fail", message)"""
    doc_id, sha, raw_key, meta, doc_date = row
    try:
        doc = structure(_w["load"](sha, raw_key), le1980=bool(meta.get("cap")))
        if doc["warnings"][:1] and doc["warnings"][0].startswith("not English"):   # listed as English, isn't
            return "skip", f"skip {meta.get('act_no')}: {doc['warnings'][0]}"
        key, certified = act_key(meta, doc), (doc_date or "")[:10] or None
        if meta.get("cap"):
            # two chapters under one number (Customs and Masters Attendant, both 235, 2026-10-07): the
            # first-listed keeps cap:N, the other cap:N@<document id>. ponytail: listing order, not which is right
            cur = _w["conn"].cursor()
            cur.execute("SELECT min(id) FROM documents WHERE source = 'le1980' AND meta->>'cap' = %s", (key[4:],))
            first = cur.fetchone()[0]
            _w["conn"].rollback()
            if first is not None and first != doc_id:
                doc["warnings"].append(f"Chapter {key[4:]} is also document {first}: keyed {key}@{doc_id}")
                key = f"{key}@{doc_id}"
            if key.split("@")[0] != f"cap:{meta['cap']}":
                doc["warnings"].append(f"listed as Chapter {meta['cap']}, prints Chapter {key[4:]}")
            # no "CHAPTER N" line of its own on page 1: lankalaw's title, "Vehicles (Chapter 534)"
            doc["title"] = doc["title"] or re.sub(r"\s*\(Chapter[^)]*\)?\s*$", "", meta["listing"]["title"])
        if meta.get("date_precision") == "year":   # lankalaw rows: only the year; the Act prints its date
            printed = parse_date(doc["certified"] or "")
            if printed and printed[:4] == key[-4:]:
                certified = printed
            elif printed:       # OCR misread (1465) or lankalaw linked another Act's file (5 Acts, 2026-10-07)
                doc["warnings"].append(f"printed date {printed} is not in {key[-4:]}: kept the year only")
        if meta.get("cap"):     # 1980 Revised Edition: the date under the long title, the law's first enactment
            certified = parse_date(doc["certified"] or "")
        date, comm = commencement(doc, certified)
        conn = _w["conn"]
        with conn, conn.cursor() as cur:         # one transaction per Act
            cur.execute("DELETE FROM acts WHERE key = %s", (key,))
            cur.execute("""INSERT INTO acts (key, document_id, raw_key, built_with, title, long_title, certified,
                           commenced, commencement, warnings, doc) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (key, doc_id, raw_key, BUILD, doc["title"], doc["long_title"], certified, date, Json(comm),
                         Json(doc["warnings"]), Json(doc)))
            execute_values(cur, "INSERT INTO sections (act_key, num, kind, seq, note, part, chapter, heading, text) "
                                "VALUES %s ON CONFLICT DO NOTHING", provisions(doc, key))
            es = edges(doc, key, date)
            if es:
                execute_values(cur, "INSERT INTO edges (src_act, src_section, kind, dst_act, dst_section, date, "
                                    "new_text, evidence) VALUES %s", es)
        return "ok", ""
    except Exception as e:
        try:
            _w["conn"].rollback()
        except Exception:
            _w["conn"] = psycopg2.connect(os.environ["DATABASE_URL"])   # dropped connection
        return "fail", f"FAIL {sha[:12]}: {e}"[:300]


def build(limit=None, workers=16, local=None, full=False):
    """local: a directory of raw .json.gz files to use instead of R2 (testing); only the
    documents rows whose sha256 is among them are built."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    shas = [json.load(gzip.open(f))["sha256"] for f in Path(local).glob("*.json.gz")] if local else None
    cur.execute("""SELECT DISTINCT ON (d.sha256) d.id, d.sha256, d.raw_key, d.meta, d.doc_date FROM documents d
                   WHERE d.raw_key IS NOT NULL AND d.meta->>'lang' = 'ENGLISH'
                     AND (%s::text[] IS NULL OR d.sha256 = ANY(%s))
                     AND (%s OR NOT EXISTS (SELECT 1 FROM acts a WHERE a.document_id = d.id AND a.raw_key = d.raw_key
                                            AND a.built_with = %s AND a.structured_at >= d.extracted_at))
                   ORDER BY d.sha256, d.id LIMIT %s""", (shas, shas, full, BUILD, limit))
    rows = cur.fetchall()
    conn.close()
    print(f"{len(rows)} Acts to build ({'all' if full else 'new, re-extracted or built with older code'})", flush=True)
    n = {"ok": 0, "skip": 0, "fail": 0}
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(local,)) as ex:
        for i, (status, msg) in enumerate(ex.map(build_one, rows, chunksize=4), 1):
            n[status] += 1
            if msg:
                print(f"[{i}/{len(rows)}] {msg}", flush=True)
            if i % 25 == 0 or i == len(rows):
                print(f"[{i}/{len(rows)}] {n['ok']} structured, {n['skip']} skipped, {n['fail']} failed", flush=True)
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        link(cur)
    conn.close()


NAMED = re.compile(r"([A-Z][A-Za-z,'’()\s-]{3,120}?)\s+(ACT|LAW|ORDINANCE)\s*,?\s*No\.?\s*(\d{1,3})\s+OF\s+(\d{4})", re.I)
LISTED = re.compile(r"\b(Ac[it]s?|Ordinances?|Laws?)\s*Nos?\s*[.,]?\s*(\d{1,3})\s*of\s*(\d{4})", re.I)


def title_key(t):
    """'CODE OF CRIMINAL PROCEDURE ACT, No. 15 OF 1979' and 'Code of Criminal Procedure' -> 'CODE OF CRIMINAL PROCEDURE'."""
    t = re.sub(r"\b(?:ACT|ORDINANCE|LAW)\b.*$|\bNo\.?\s*\d+.*$|\(\s*CHAPTER.*$", "", (t or "").upper())
    return " ".join(re.sub(r"[^A-Z ]", " ", t).split())


def link(cur):
    """same_as between a pre-1980 law and the 1980 Revised Edition chapter that consolidates it, so edges
    into either key reach the text (walk follows same_as); and 1972-78 Laws' law: keys (below). Two signals:
      * the chapter's front lists the laws it consolidates, principal first ("Acts Nos.33 of 1961 17 of 1964",
        cap 203; OCR'd as "Acis"): only the first is linked, the later ones are mostly amending Acts whose
        section numbers are not the chapter's
      * a pre-1980 Act or Law (not an amending one) whose title is exactly one chapter's title, and that
        chapter's only match (Code of Criminal Procedure = 15/1979 = cap 26)
    Re-run after every build: rebuilding a chapter drops its edges. Marked new_text = 'link'."""
    cur.execute("DELETE FROM edges WHERE kind = 'same_as' AND new_text = 'link'")
    cur.execute("SELECT a.key, a.title, d.title, a.doc->'front', a.doc->>'long_title' FROM acts a "
                "JOIN documents d ON d.id = a.document_id")
    rows = cur.fetchall()
    pairs = {}
    for key, title, listed_title, front, lt in rows:
        if key.startswith(("cap:", "cap1956:")) and (m := LISTED.search(" ".join((front or [])[:12] + [lt or ""]))):
            kind = {"a": "act", "o": "ordinance", "l": "law"}[m[1][0].lower()]
            pairs[(key, f"{kind}:{int(m[2])}/{m[3]}")] = "listed"
    caps, laws = {}, {}
    for key, title, listed_title, *_ in rows:
        names = {title_key(title), title_key(listed_title)} - {"", None}
        if key.startswith(("cap:", "cap1956:")):
            for n in names:
                caps.setdefault(n, set()).add(key)
        if key.startswith("cap1956:"):
            # a chapter number cited without a name whose edition is unknown (chapter:N): the 1956 one.
            # Checked 2026-10-09: chapter:203 (138 edges) = Motor Traffic, 262 = Local Authorities Elections,
            # 252 = Municipal Councils, 182 = Firearms: all 1956 numbers
            pairs[(key, "chapter:" + key[8:])] = "1956"
        elif re.match(r"(?:act|law):\d+/19[0-7]\d$", key) and not re.search(r"AMENDMENT", f"{title} {listed_title}", re.I):
            for n in names:
                laws.setdefault(n, set()).add(key)
    for n, ks in laws.items():
        for cap in caps.get(n, ()):          # one chapter per edition: a 1956 and a 1980 one may both match
            if len(ks) == 1 and sum(c.split(":")[0] == cap.split(":")[0] for c in caps[n]) == 1:
                pairs.setdefault((cap, next(iter(ks))), "title")
    # the same law in both editions, by title (Penal Code = 1956 chapter 19 = 1980 chapter 19)
    for n, cs in caps.items():
        c56, c80 = [c for c in cs if c.startswith("cap1956:")], [c for c in cs if c.startswith("cap:")]
        if len(c56) == 1 and len(c80) == 1:
            pairs.setdefault((c56[0], c80[0]), "editions")
    # 1972-78 National State Assembly Laws are built under lankalaw's number as act:N/YYYY; amending Acts
    # cite them as "Law No. 5 of 1972" (law:5/1972, 680 unresolved edges on 2026-10-09). The file says
    # which it is: a long title "A LAW TO ..." or "Law" in its title
    # 1973-77 had only Laws, so "Act No. 2 of 1974" can only mean that Law: always the same node. 1972 and
    # 1978 had both, numbered separately (Act 5/1972 Agrarian Research ≠ Law 5/1972 Co-operative Societies),
    # so there only the file's own word counts
    for key, title, listed_title, front, lt in rows:
        if re.fullmatch(r"act:\d+/197[3-7]", key) or (re.fullmatch(r"act:\d+/197[28]", key) and
                (re.match(r"\s*A\s+LAW\b", lt or "", re.I) or re.search(r"\bLAW\b", f"{title} {listed_title}", re.I))):
            pairs[(key, "law:" + key[4:])] = "law"
    # a cited law we hold no file for, by the name the citing text gives it: 1972 and 1978 have an Act and a
    # Law under the same number ("THE CO-OPERATIVE SOCIETIES LAW, No. 5 OF 1972" is not Act 5/1972, the
    # Agrarian Research and Training Institute Act), and lankalaw lists one file per number; the Law sits in
    # the 1980 Revised Edition under its name. The longest tail of the cited name that is exactly one
    # chapter's title (1980 edition first) wins; a name more than one key claims decides nothing.
    built = {r[0] for r in rows}
    cur.execute("SELECT DISTINCT dst_act, evidence FROM edges WHERE evidence IS NOT NULL AND kind <> 'same_as'")
    cited = {}
    for dst, ev in cur.fetchall():
        if dst in built:
            continue
        for m in NAMED.finditer(ev):
            if f"{m[2].lower()}:{int(m[3])}/{m[4]}" != dst:
                continue
            words = re.sub(r"[^A-Z ]", " ", m[1].upper()).split()     # not title_key: it cuts at "AN ACT"
            for i in range(len(words)):
                tail = " ".join(words[i:])
                hit = sorted(caps.get(tail, ()), key=lambda c: c.startswith("cap1956:"))
                if hit and sum(c.split(":")[0] == hit[0].split(":")[0] for c in hit) == 1:
                    cited.setdefault(dst, set()).add(hit[0])
                    break
    linked = {law for _, law in pairs}
    for dst, cs in cited.items():
        if len(cs) == 1 and dst not in linked:
            pairs[(next(iter(cs)), dst)] = "cited name"
    execute_values(cur, "INSERT INTO edges (src_act, kind, dst_act, new_text, evidence) VALUES %s",
                   [(cap, "same_as", law, "link", f"also {cap}") for (cap, law) in pairs])
    by = Counter(pairs.values())
    print(f"linked {len(pairs)}: {by['listed']} laws to their chapter from the chapter's list, {by['title']} by title, "
          f"{by['editions']} 1956 chapters to 1980 ones by title, {by['1956']} chapter:N to cap1956:N, "
          f"{by['law']} 1972-78 Laws to their law: key, {by['cited name']} cited laws to a chapter by the name cited", flush=True)


def why_missing(cur, key):
    """Why an Act key has no row in `acts`: what to fetch or extract to fill it."""
    kind, _, ref = key.partition(":")
    if kind == "chapter":
        return "chapter cited by number only, its law not named: 1956 or 1980 numbering unknown"
    if kind == "cap":
        cur.execute("SELECT raw_key IS NOT NULL FROM documents WHERE source = 'le1980' AND meta->>'cap' = %s", (ref,))
        r = cur.fetchone()
        return ("1980 Revised Edition chapter, fetched but not extracted yet" if r and not r[0] else
                "1980 Revised Edition chapter, extracted but not built yet" if r else
                "pre-1980 law: 1980 Revised Edition not fetched (etl.fetch le1980)")
    year = int(ref.split("/")[-1]) if "/" in ref else 0
    if kind != "act" or year < 1980:
        # Laws (1972-77), Ordinances and pre-1980 Acts are in the 1980 Revised Edition, but under a
        # chapter number: reaching them by number needs a number -> chapter map (not built)
        return f"pre-1980 {kind}: in the 1980 Revised Edition under a chapter number (needs number -> chapter map)"
    cur.execute("""SELECT count(*), count(*) FILTER (WHERE meta->>'lang' = 'ENGLISH'),
                          count(*) FILTER (WHERE meta->>'lang' = 'ENGLISH' AND raw_key IS NOT NULL),
                          count(*) FILTER (WHERE meta->>'lang' = 'ENGLISH' AND error IS NOT NULL)
                   FROM documents WHERE source = 'acts' AND meta->>'act_no' = %s""", (ref,))
    n, en, en_raw, en_err = cur.fetchone()
    if not n:
        return "not on documents.gov.lk: try the lk_legal_docs mirror or lankalaw year pages"
    if not en:
        return "listed, but no English file (Sinhala/Tamil only)"
    if en_err and not en_raw:
        return "English file failed extraction"
    if not en_raw:
        return "English file not extracted yet"
    return "extracted but not built yet (run etl.graph build)"


def missing():
    """Every Act key edges point at that has no row in `acts`, most-referenced first, with why."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute("""SELECT e.dst_act, count(*) FILTER (WHERE e.kind <> 'cites'), count(*) FILTER (WHERE e.kind = 'cites')
                   FROM edges e WHERE e.kind <> 'same_as' AND NOT EXISTS (SELECT 1 FROM acts a WHERE a.key = e.dst_act)
                   GROUP BY 1 ORDER BY 2 DESC, 3 DESC""")
    rows = [(k, ch, ci, why_missing(cur, k)) for k, ch, ci in cur.fetchall()]
    conn.close()
    return rows


def walk(target, section, year):
    """Section `section` of Act `target` (e.g. 14/2002) as of the end of `year`: its original text
    (if that Act is structured) and every edge into it, or into the whole Act, dated by then."""
    key = target if ":" in target else f"act:{target}"
    if re.fullmatch(r"\d+[A-Za-z]*", section):
        section = section.upper()                        # 12a -> 12A
    elif section.lower() == "preamble":
        section = "Preamble"
    else:
        section = sched_name(section) or section         # "first schedule" -> First Schedule
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    # every name of the law: same_as pairs are stored as dst_act + evidence "also <other key>"
    cur.execute("SELECT dst_act, substr(evidence, 6) FROM edges WHERE kind = 'same_as'")
    names, pairs = {key}, cur.fetchall()
    for _ in range(3):
        names |= {b for a, b in pairs if a in names} | {a for a, b in pairs if b in names}
    names = sorted(names)
    cur.execute("SELECT a.title, a.certified, s.note, s.text FROM sections s JOIN acts a ON a.key = s.act_key "
                "WHERE s.act_key = ANY(%s) AND s.num = %s", (names, section))
    original = cur.fetchone()
    # each change comes with the whole amending section: the instruction ("by the repeal of the first
    # proviso ... and the substitution therefor of the following") is as needed as the new words
    def changes_to(acts, sec, depth=0, whole_act=True):
        cur.execute("""SELECT e.date, e.src_act, a.title, e.src_section, e.kind, e.dst_section, e.new_text, e.evidence,
                              s.text, a.commencement
                       FROM edges e JOIN acts a ON a.key = e.src_act
                       LEFT JOIN sections s ON s.act_key = e.src_act AND s.num = e.src_section
                       WHERE e.dst_act = ANY(%s) AND (e.dst_section = %s OR (%s AND e.kind = 'repeals_act'))
                         AND e.kind <> 'cites' AND (e.date IS NULL OR e.date <= make_date(%s, 12, 31))
                       ORDER BY e.date NULLS LAST, e.src_act, e.src_section""", (acts, sec, whole_act, year))
        out = [dict(zip(("date", "by_act", "by_title", "by_section", "kind", "section", "new_text", "evidence",
                         "amending_text", "commencement"), r)) for r in cur.fetchall()]
        for c in out:
            # amendments of amendments: a later Act changing the amending section itself
            if depth < 3 and c["by_section"]:
                c["amended_by"] = changes_to([c["by_act"]], c["by_section"], depth + 1, False)
            if (c["commencement"] or {}).get("kind") == "appointed":
                c["date_note"] = "in force on a date appointed by Gazette Order (not in the corpus); certified date shown"
        return out
    changes = changes_to(names, section)
    gap = None
    if not original:      # say why, so a missing original is never silent
        cur.execute("SELECT key FROM acts WHERE key = ANY(%s)", (names,))
        gap = (f"section {section} not found in the structured Act" if cur.fetchone()
               else "; ".join(f"{n}: {why_missing(cur, n)}" for n in names))
    conn.close()
    return {"act": key, "also_known_as": [n for n in names if n != key], "section": section, "as_of": year,
            "original": original and dict(zip(("act_title", "certified", "note", "text"), original)),
            **({"original_missing": gap} if gap else {}),
            "changes": changes}


def main():
    a = argparse.ArgumentParser()
    sub = a.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--limit", type=int)
    b.add_argument("--workers", type=int, default=16)
    b.add_argument("--local", help="directory of raw .json.gz to use instead of R2 (testing)")
    b.add_argument("--full", action="store_true", help="rebuild every Act, not only new or changed ones")
    sub.add_parser("missing", help="Acts that edges point at but that are not built, with the reason")
    sub.add_parser("link", help="same_as between pre-1980 laws and their 1980 chapters (also run by build)")
    w = sub.add_parser("walk")
    w.add_argument("act", help="14/2002, or a key like cap:107")
    w.add_argument("section")
    w.add_argument("--year", type=int, default=9999)
    args = a.parse_args()
    if args.cmd == "build":
        build(args.limit, args.workers, args.local, args.full)
    elif args.cmd == "link":
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        with conn, conn.cursor() as cur:
            link(cur)
        conn.close()
    elif args.cmd == "missing":
        rows = missing()
        for k, ch, ci, why in rows[:60]:
            print(f"{k:18} {ch:4} changes {ci:4} citations | {why}")
        print(f"\n{len(rows)} targets not built:", dict(Counter(r[3].split(':')[0] for r in rows)))
    else:
        print(json.dumps(walk(args.act, args.section, args.year), ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
