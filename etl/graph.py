#!/usr/bin/env python3
"""Edges and same_as pairs from the structured Acts (`acts.doc`, etl.structure build). etl.docs uses only the
same_as pairs (`links()`) and the name lookups here (load_chapters, law_by_name, key_of, sched_names); its own
links come from etl.refs.

  python3 -m etl.graph build      # every Act's acts.doc -> edges (all rebuilt), then link
  python3 -m etl.graph link       # same_as only

Edges are read from text the structure step already isolates, not guessed:
  amends_act / repeals_act   long title "AN ACT TO AMEND THE ... ACT, NO. 14 OF 2002"
  amends | replaces | repeals | inserts
                             marginal note "Amendment of section 22 of Act, No. 14 of 2002" /
                             "... of the principal enactment" (defined once, "hereinafter referred to
                             as the 'principal enactment'"); new_text = the section's quoted paragraphs
  repeals_act                a section whose note says Repeal without naming a section
  cites                      "Act, No. 19 of 1994", "(Chapter 26)" in this Act's own (unquoted) text
  same_as                    one law under two keys, act:44/1953 = cap:432 (its 1980 Revised Edition chapter)
"""
import argparse, os, re
from collections import Counter

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import execute_values

from etl.structure import is_law_year, sched_name, text_of

load_dotenv()
CIT = re.compile(r"\b(Act|Law|Ordinance),?\s*No\.?\s*(\d+)\s+of\s+(\d{4})", re.I)
CHAP = re.compile(r"\b(?:Chapter|Cap\.?)\s*(\d+[A-Z]?)\b")        # digits only: this Act's own CHAPTERs are roman
NOTE = re.compile(r"^(Amendment|Replacement|Substitution|Repeal|Insertion|Addition)s?\b(.*)$", re.I)
# "(hereinafter referred to as the 'principal enactment')", also unquoted, with a space inside the quote
# (law:12/1976 '" principal enactment "') or "the principal Act"
PRINCIPAL = re.compile(r"referred\s+to\s+as\s+(?:the\s+)?['‘’\"“”]{0,2}\s*(?:the\s+)?principal\s+(?:enactment|Act|Law|Ordinance)\b", re.I)
KIND = {"amendment": "amends", "replacement": "replaces", "substitution": "replaces",
        "repeal": "repeals", "insertion": "inserts", "addition": "inserts"}


# "Chapter N" is ambiguous: later Acts cite pre-1980 law by its 1956 Revised Edition chapter as often as by
# its 1980 one ("section 53 of the Penal Code (Chapter 19)", 10/2018; Chapter 19 in 1980 is Courts' Records).
# The law's name is not ambiguous, so a chapter citation resolves by the name printed before it.
CHAPTERS = {}            # normalised 1980 chapter title -> its acts key (load_chapters, once per build)
TITLES = {}              # normalised title of a principal Act/Law -> its key (load_chapters)
_cite = {"local": {}, "le": False, "old": False}   # per Act: chapter number -> key by name; in a 1980 chapter? before 1959?


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
    # ...and every principal Act or Law by its title ("the Banking Act" = act:30/1988), for a principal enactment
    # named without a usable number; amending Acts are left out, a title two laws share decides nothing
    cur.execute("SELECT key, title FROM acts WHERE key ~ '^(act|law):' AND title !~* 'amendment|appropriation'")
    seen = {}
    for k, t in cur.fetchall():
        n = norm_name(re.sub(r",?\s*No\.?\s*\d+\s+of\s+\d{4}.*$", "", t or "", flags=re.I))
        if n:
            seen.setdefault(n, set()).add(k)
    TITLES.clear()
    TITLES.update({n: next(iter(ks)) for n, ks in seen.items() if len(ks) == 1})


def law_by_name(text, acts=False):
    """The chapter whose title ends `text` ("Section 4 of the Maternity Benefits Ordinance"), longest
    name first; with acts=True also a principal Act's title ("Section 2 of the Banking Act"). None if none."""
    words = re.findall(r"[A-Za-z’'-]+", text[-160:])
    for k in range(min(12, len(words)), 0, -1):
        n = norm_name(" ".join(words[-k:]))
        if (hit := CHAPTERS.get(n) or (acts and k > 1 and TITLES.get(n))):
            return hit
    return None


def younger(target, key):
    """Is `target` a numbered law dated after `key`? Then it can't be what `key` amends (a misprinted year)."""
    y = lambda k: int(k[-4:]) if k and re.search(r"/\d{4}$", k) else None
    return y(target) is not None and y(key) is not None and y(target) > y(key)


def chapter_by_name(m):
    """The chapter whose title ends the text just before "(Chapter N)"."""
    return law_by_name(m.string[max(0, m.start() - 160):m.start()])


def key_of(m):
    """A citation match -> node key: act:14/2002, law:1/1975, ordinance:5/1950, cap:107 (a 1980 chapter),
    chapter:19 (a chapter number whose law isn't named, so the edition is unknown)."""
    if m.re is CHAP:
        # in a 1980 chapter: 1980 numbers. Acts up to 1958 still cite the 1938 edition's numbers (2026-10-10: every
        # named "X (Chapter N)" in 1956-58 Acts, 5 of 5, is not X's 1956 number; from 1961, 15 of 18 are): a bare
        # one there is left unlinked (chapter1938:N) rather than tied to the wrong 1956 chapter (3/1956's Income Tax
        # "Chapter 188" was linked to the 1956 Antiquities Ordinance)
        return (chapter_by_name(m) or _cite["local"].get(m[1])
                or (f"cap:{m[1]}" if _cite["le"] else f"chapter1938:{m[1]}" if _cite["old"] else f"chapter:{m[1]}"))
    kind, no = m[1].lower(), f"{int(m[2])}/{m[3]}"
    if kind == "law" and not 1972 <= int(no[-4:]) <= 1978:
        kind = "act"         # Laws were passed only 1972-78: "Village Councils Law, No. 6 of 1964" is an Act
    return f"{'law' if kind == 'act' and is_law_year(no) else kind}:{no}"   # "Act No. 2 of 1974" = Law 2/1974


def first_target(text):
    hits = sorted([m for r in (CIT, CHAP) for m in r.finditer(text or "")], key=lambda m: m.start())
    return key_of(hits[0]) if hits else None


ORDS = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth"
LIST = r"(?:\s*,\s*(?:and\s+)?|\s+and\s+)"


def sched_names(t):
    """Every schedule a note names: "the First and Second Schedules", "Schedules I, II, III,IV, IVA and V"
    -> one name each (one edge each; the first form gave only the Second, the second none, 2026-10-10)."""
    if (m := re.search(rf"\b((?:(?:{ORDS.replace(' ', '|')}){LIST})+(?:{ORDS.replace(' ', '|')}))\s+Schedules\b", t, re.I)):
        return [f"{w.title()} Schedule" for w in re.findall(rf"\b(?:{ORDS.replace(' ', '|')})\b", m[1], re.I)]
    if (m := re.search(rf"\bSchedules\s+((?:[IVX]+[A-Z]?|[A-Z]|\d+){LIST}(?:(?:[IVX]+[A-Z]?|[A-Z]|\d+){LIST})*(?:[IVX]+[A-Z]?|[A-Z]|\d+))\b", t)):
        return [f"Schedule {x}" for x in re.split(LIST, m[1])]
    return [n] if (n := sched_name(t)) else []


QOPEN = re.compile(r"^[\"'‘’“”]{0,2}\s*(\d{1,3}[A-Z]{0,5})\s*\.\s+\S")


def quoted_sections(s):
    """Section numbers a section's quoted text opens, in order: "“25A. (1) ...", "25B. Where ..." -> 25A, 25B."""
    return list(dict.fromkeys(m[1] for p in s["paras"] if p.get("quoted") and (m := QOPEN.match(p["text"]))))


def edges(doc, key, date):
    out = []
    lt = doc["long_title"] or ""
    # a bare "Chapter 19" means the law this Act names as Chapter 19 elsewhere ("the Penal Code (Chapter 19)")
    _cite["le"], _cite["local"] = key.startswith("cap:"), {}
    _cite["old"] = bool(re.search(r"/19[0-5]\d$", key)) and int(key[-4:]) <= 1958
    for m in CHAP.finditer(" ".join([lt] + [text_of(s) for s in doc["sections"]])):
        if m[1] not in _cite["local"] and (hit := chapter_by_name(m)):
            _cite["local"][m[1]] = hit
    lt_target = first_target(lt)
    # the long title naming the Act itself or a younger law (misprint, "TO AMEND THE BANKING ACT, NO. 33 OF 1995" in
    # 33/1995): the law by its name instead
    if lt_target and (lt_target == key or younger(lt_target, key)):
        lt_target = law_by_name(re.sub(r",?\s*No\.?\s*\d+\s+of\s+\d{4}.*$", "", lt, flags=re.I | re.S), acts=True)
    # one law named without a number, "AN ACT TO AMEND THE MATERNITY BENEFITS ORDINANCE." (24/1962): its
    # chapter by exact title
    if not lt_target and (m := re.match(r"\s*AN?\s+(?:ACT|LAW)\s+TO\s+(?:AMEND|REPEAL)\s+THE\s+([A-Z ,'’()&-]+?"
                                        r"(?:ACT|ORDINANCE|LAW|CODE))\s*[.§Â]*\s*$", lt, re.I)):
        lt_target = CHAPTERS.get(norm_name(m[1]))
    # "AN ACT TO AMEND THE CONSTITUTION OF THE DEMOCRATIC SOCIALIST REPUBLIC OF SRI LANKA" (0/YYYY, amendment:N);
    # the 1978 base text is not in the corpus yet, so these edges wait for it
    if not lt_target and re.match(r"AN\s+ACT\s+TO\s+AMEND\s+THE\s+CONSTITUTION\b", lt, re.I):
        lt_target = "constitution"
    if lt_target and re.match(r"AN?\s+(?:ACT|LAW)\s+TO\s+(AMEND|REPEAL|PROVIDE FOR THE REPEAL)", lt, re.I):
        kind = "repeals_act" if re.search(r"\bREPEAL\b", lt[:40], re.I) and "AMEND" not in lt[:20].upper() else "amends_act"
        for t in dict.fromkeys(key_of(x) for r in (CIT, CHAP) for x in r.finditer(lt)) or [lt_target]:   # all laws it names
            out.append((None, kind, t, None, None, lt))
    # the long title names one law (in words too: 33/1968 names an Ordinance without a number and Finance
    # 11/1963): a surer principal than one note when the text's number is wrong
    named = len(re.findall(r"\b(?:ACT|ORDINANCE|LAW|CODE)\b", re.sub(r"^\s*AN?\s+(?:ACT|LAW)\b", "", lt, flags=re.I), re.I))
    lt_one = lt_target if named == 1 else None
    principal = None
    for s in doc["sections"]:
        own = text_of(s, quoted=False)
        note = s["note"] or ""
        if not principal and (m := PRINCIPAL.search(own)):
            # the law named just before the phrase, skipping "... as last amended by Act, No. 24 of 1999",
            # which names an amending Act, not the principal one (6 wrong aliases on the first Neon build)
            pre = own[:m.start()]
            # ...and no law younger than this one: CommonLII's law:30/1978 says "Inland Revenue Act, No. 4 of
            # 1983" for 4/1963 (its long title is right), which sent 46 edges into a 1983 Act
            year = int(key[-4:]) if re.search(r"/\d{4}$", key) else 9999
            before = sorted([x for r in (CIT, CHAP) for x in r.finditer(pre)
                             if not re.search(r"amended\s+by\s*(?:the\s+)?$", own[max(0, x.start() - 40):x.start()], re.I)
                             and not (x.re is CIT and int(x[3]) > year) and key_of(x) != key],
                            key=lambda x: x.start())
            if before:
                principal = key_of(before[-1])
            else:
                # named without a number, "Section 4 of the Maternity Benefits Ordinance (hereinafter ...)":
                # by its chapter title, else the one law the long title names, else what this section's own
                # note names ("... of Chapter 140."; 2,522 principal-enactment notes in 286 laws had no edge
                # before, 2026-10-10)
                name = re.sub(r"here(?:in)?-?\s*after(?!.*here(?:in)?-?\s*after).*$", "", pre, flags=re.I | re.S)
                name = re.sub(r"[\s(,]*(?:as\s+(?:last\s+)?amended\s+by\b.*)?[\s(,]*$", "", name, flags=re.I | re.S)
                name = re.sub(r",?\s*No\.?\s*\d+\s+of\s+\d{4}\s*$", "", name, flags=re.I)   # its (misprinted) number
                principal = law_by_name(name, acts=True) or lt_one
                nm = NOTE.match(note.strip())
                if principal:      # the note's bare "Chapter 140" is this law too (1956 or 1980 number)
                    for c in CHAP.finditer(nm[2] if nm else ""):
                        _cite["local"].setdefault(c[1], principal)
                else:
                    principal = first_target(nm[2]) if nm else None
        if (m := NOTE.match(note.strip())):
            rest = m[2]
            # a note without its own target means the principal enactment ("Replacement of Form F of
            # the Second Schedule", 47/2011)
            note_law = first_target(rest)
            if note_law and (note_law == key or younger(note_law, key)):   # "Act No. 30 of 1998" in a 1995 Act (33/1995): misprint
                note_law = None
            target = note_law or ("constitution" if re.search(r"\bConstitution\b", rest) else None) or principal or lt_target
            # what is changed: "section 22", "sections 12A, 12B and 12C", "the First Schedule"
            # ...or the Constitution's "Article 91", "Articles 104A and 104B"
            sm = re.search(r"\b(?:sections?|articles?)\s*((?:\d+[A-Z]*)(?:\s*(?:,|and|to)\s*\d+[A-Z]*)*)", rest, re.I)  # "sections12A" (9/2018)
            scheds = sched_names(rest)
            kind = KIND[m[1].lower()]
            if kind == "repeals" and re.search(r"replace|substitut", rest, re.I):
                kind = "replaces"
            new = text_of(s, quoted=True) or None
            if target and sm:
                for n in re.findall(r"\d+[A-Za-z]*", sm[1]):       # "161c" (8/2022)
                    n = n.upper()
                    out.append((s["num"], kind, target, n, new, note))
            elif target and scheds:
                for sched in scheds:
                    out.append((s["num"], kind, target, sched, new, note))
            elif target and (pm := re.search(r"\b(Part|Chapter)\s+([IVXL]+[A-Z]?)\b", rest)):
                # "Insertion of new Part VIIIA": the link names the Part; the inserted text is in the source chunk
                out.append((s["num"], kind, target, f"{pm[1].title()} {pm[2]}", new, note))
            elif kind == "repeals":     # "Repeal of Chapter 170." / "Repeal and savings": the laws the note, else the text, names
                # ...but "Part IX of the Medical Ordinance (Chapter 105) is hereby repealed" (19/1988) repeals a part of
                # it, not the law: kept as a repeal with no section, which the walk doesn't apply to every section
                part = re.search(r"\b(?:Parts?|sections?|sub-?sections?|paragraphs?|Schedules?|Chapter\s+[IVXL]+)\b[^.;]{0,80}?\bof\b",
                                 own[:own.find("repealed")] if "repealed" in own else own, re.I)
                for t in ({key_of(x) for r in (CIT, CHAP) for x in r.finditer(rest)}
                          or {key_of(x) for r in (CIT, CHAP) for x in r.finditer(own)}) - {key}:
                    out.append((s["num"], "repeals" if part else "repeals_act", t, None, None, note))
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
    # ...only if the long title names one law in words too (`named`): 21/2012 amends two Ordinances named
    # without numbers and Act 15/1987, which is not Chapter 252
    if principal and len(lt_all) == 1 and named == 1 and principal not in lt_all:
        pairs.add((next(iter(lt_all)), principal))
    out += [(None, "same_as", a, None, None, f"also {b}") for a, b in pairs if a != b]
    # an Act doesn't amend itself: its own number in the long title (33/1995) or principal (48/1999)
    return [(key, *e[:4], date, *e[4:]) for e in out if e[2] != key]          # date: the Act's commencement


def build():
    """Every edge again, from the acts.doc that step 3 stored: regex over text already isolated, so a full
    rebuild is cheap and an edge-rule change never needs a re-structure. One transaction: readers see
    the old edges until it commits. Chapter names (load_chapters) are read after step 3 has finished,
    so a chapter structured in the same run resolves at once."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn, conn.cursor() as cur:
        load_chapters(cur)
        cur.execute("SELECT key, doc, commenced FROM acts")
        es = [e for key, doc, date in cur.fetchall() for e in edges(doc, key, date)]
        cur.execute("DELETE FROM edges")
        execute_values(cur, "INSERT INTO edges (src_act, src_section, kind, dst_act, dst_section, date, "
                            "new_text, evidence) VALUES %s", es, page_size=2000)
        print(f"{len(es)} edges:", dict(Counter(e[2] for e in es)), flush=True)
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
    into either key reach the text (walk follows same_as). Signals:
      * the chapter's front lists the laws it consolidates, principal first ("Acts Nos.33 of 1961 17 of 1964",
        cap 203; OCR'd as "Acis"): only the first is linked, the later ones are mostly amending Acts whose
        section numbers are not the chapter's
      * a pre-1980 Act or Law (not an amending one) whose title is exactly one chapter's title, and that
        chapter's only match (Code of Criminal Procedure = 15/1979 = cap 26)
    Run by every build (and after it: rebuilding edges drops these). Marked new_text = 'link'."""
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
    # a cited law we hold no file for, by the name the citing text gives it: 1972 and 1978 have an Act and a
    # Law under the same number ("THE CO-OPERATIVE SOCIETIES LAW, No. 5 OF 1972" is not Act 5/1972, the
    # Agrarian Research and Training Institute Act), and lankalaw lists one file per number; the Law sits in
    # the 1980 Revised Edition under its name. The longest tail of the cited name that is exactly one
    # chapter's title (1980 edition first) wins; a name more than one key claims decides nothing. Citing texts
    # that disagree are outvoted when one chapter has more than all others together: law:18/1976 prints
    # "CEILING ON HOUSING PROPERTY LAW, NO. 1 OF 1972" (that Law is 1/1973) against 4 texts naming Land Reform.
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
                    cited.setdefault(dst, Counter())[hit[0]] += 1
                    break
    linked = {law for _, law in pairs}
    for dst, cs in cited.items():
        (top, n), *rest = cs.most_common()
        if n > sum(m for _, m in rest) and dst not in linked:
            pairs[(top, dst)] = "cited name"
    execute_values(cur, "INSERT INTO edges (src_act, kind, dst_act, new_text, evidence) VALUES %s",
                   [(cap, "same_as", law, "link", f"also {cap}") for (cap, law) in pairs])
    by = Counter(pairs.values())
    print(f"linked {len(pairs)}: {by['listed']} laws to their chapter from the chapter's list, {by['title']} by title, "
          f"{by['editions']} 1956 chapters to 1980 ones by title, {by['1956']} chapter:N to cap1956:N, "
          f"{by['cited name']} cited laws to a chapter by the name cited", flush=True)


def main():
    a = argparse.ArgumentParser()
    sub = a.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build", help="every edge again from acts.doc (step 3 output), then link")
    sub.add_parser("link", help="same_as between pre-1980 laws and their 1980 chapters (also run by build)")
    args = a.parse_args()
    if args.cmd == "build":
        build()
    elif args.cmd == "link":
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        with conn, conn.cursor() as cur:
            link(cur)
        conn.close()


if __name__ == "__main__":
    main()
