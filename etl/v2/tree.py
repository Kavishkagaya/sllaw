"""Stage 4: paragraphs -> a document's structure tree, generic for every type (docs/PIPELINE_V2.md).

The tree:
  document
  ├─ front                 paragraphs before the first unit or heading (title, long title, enacting formula)
  ├─ scope                 a Part/Chapter heading whose numbers run in order from I; its units are its children
  │   └─ unit              a numbered provision (section, Article, regulation) with its note
  ├─ unit / block          at the top when no Part is open; a block = an unlabelled run (after a heading that is
  │                         not a scope: out of sequence, or in an amending law)
  └─ schedule              a SCHEDULE heading; numbering restarts, so its numbered lines are items, not units
Each container holds the paragraphs that belong to it, each with a kind: text, item (with its marker and level),
proviso, explanation, illustration, definition, quote, table, annotation, end, heading_text.

Which numbered lines open a unit, which headings are scopes and where a schedule starts are the rules of
etl.docs.chunks() (BUILD 2026-10-29), unchanged, so labels move only where this module means them to:
  - a numbered paragraph opens a unit only if it continues the sequence: the next number, a lettered one of the
    same base (12 -> 12A), or a jump of up to 10 with its own note (or in a law printed without notes);
  - after a schedule heading numbered items are the schedule's until a section number appears with a note;
  - a Part/Chapter heading is a scope while numbers run in order from I; a break ends scopes for the document;
  - a heading leads the unit after it (its lines go into that unit) when only short heading lines precede it.
The printed contents ("Arrangement of Sections") is cut out and kept as the expected list for a check.
Added (2026-11-07): text an amendment inserts. After a paragraph ending in an amending formula ("... the following
section substituted therefor:-", etl.structure.INTRO) the text is quoted until a paragraph closes the quote: a
numbered paragraph there is the law's own next section when it continues the law's numbers (and ends the quote),
unless the formula named that number and the paragraph is no amending formula itself (etl.structure.AMEND); a number
the formula named, or any other, is quoted; headings and schedules inside are quoted, not scopes. Quoted text is
content of the section that quotes it, never a unit of its own (user, 2026-11-07). A quotation that opens with
its quote mark and does not close in that paragraph (etl.structure.quote_delta) starts the same quoting, in
amending laws only: in a principal law or a Revised Edition an unclosed mark (a definitions list) quoted its real
inserted sections (act:24/2018 4A, cap:323 5A, cap:579 39A). (A first version
that let only an amending formula end the quote swallowed whole Acts: 4,677 labels lost, act:10/2006 s106-113.) Before, the inserted
"12. The members of the Institute shall be paid ..." was read as act:29/1981's own section 12.
"""
import re

from etl.docs import FURNITURE, HEADING, MID_PART, OPENER, drop_contents, num_key, roman
from etl.structure import AMEND, INTRO, QUOTES, SCHED_HEAD, quote_delta, sched_name

CLOSES = re.compile(rf"[{QUOTES}]\s*[.;,:]?\s*$")                # a paragraph ending the quoted text: ... thereof.”.
# an amending formula, not a principal law's own "... in addition to the following:-" (act:7/2007 s119, law:24/1974)
AMENDS = re.compile(r"\bhereby\b|principal\s+(?:enactment|Act|Law|Ordinance)|of\s+that\s+(?:enactment|Act|Law|Ordinance)"
                    r"|(?:have|take)\s+effect\s+as", re.I)
AMENDING_NOTE = re.compile(r"\b(?:Amendments?|Replacement|Repeal|Insertion|Substitution|Addition)\b", re.I)


def formula_numbers(paras, key=None):
    """{paragraph index: section numbers its amending formula replaces or inserts}, read by etl/refs.py, the parser
    the links use ("Section 12 ... substituted" -> 12; "shall have effect as sections 5A, 5B and 5C" -> 5A, 5B, 5C),
    so the tree and the links read a formula alike. Only the numbers are wanted here: when the principal enactment
    is not defined yet, a placeholder stands for it (refs.py gives no link without a law)."""
    from etl import refs
    from etl.docs import long_title_of
    texts = [p["text"] for p in paras]
    d = refs.Doc(key or "act:0/2100", long_title_of(paras), texts)
    out = {}
    for i, t in enumerate(texts):
        if not INTRO.search(t):
            d.chunk(i, t)                    # earlier text can define the principal enactment
            continue
        d.principal = d.principal or "law:?"
        out[i] = {lab for _, kind, _, lab, _, _ in d.chunk(i, t) if kind in ("replaces", "inserts") and lab}
    return out


LABEL = re.compile(r"^\((\d{1,3}[A-Za-z]?|[a-z]{1,2}|[ivxlc]{1,6})\)\s")
ROMANS = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi",
          "xvii", "xviii", "xix", "xx"}
QUOTED = re.compile(r"^[\"'“‘”’]{1,2}\s*\d{1,3}[A-Z]{0,4}\s*\.\s")                 # “25A. ... (inserted text)
DEFINED = re.compile(r"^[\"'“‘]{1,2}[^\"'“”‘’]{1,60}[\"'”’]{1,2}\s*(?:\([^)]{0,40}\)\s*)?(?:means|includes|shall)\b")
ANNOT = re.compile(r"^\[\s*(?:§|\d+\]|[\d ,]+of\s+\d{4})")                           # [§ 2, 55 of 1961.]  [1]
END = re.compile(r"^(?:By\s+(?:His|Her)\s+Excellency'?s\s+Command|By\s+Order\s+of|Given\s+under\s+my\s+hand)", re.I)


def kind_of(t, p, prev_letter):
    """A paragraph's kind inside its container -> (kind, extra)."""
    if p.get("rows"):
        return "table", {}
    if HEADING.match(t) or (SCHED_HEAD.match(t.lstrip("#* ")) and len(t) < 120):
        return "heading_text", {}
    if QUOTED.match(t):
        return "quote", {}
    if (m := LABEL.match(t)):
        mk = m[1]
        if mk[0].isdigit():
            return "item", {"marker": mk, "level": 1}
        # "(i)" after "(h)" is a letter; otherwise i, ii, v, x ... are the third level
        if mk in ROMANS and not (prev_letter and len(mk) == 1 and ord(mk) == ord(prev_letter) + 1):
            return "item", {"marker": mk, "level": 3}
        return "item", {"marker": mk, "level": 2}
    if re.match(r"Provided\b", t):
        return "proviso", {}
    if re.match(r"\**\s*Explanation\b", t):
        return "explanation", {}
    if re.match(r"\**\s*Illustrations?\b", t):
        return "illustration", {}
    if DEFINED.match(t):
        return "definition", {}
    if ANNOT.match(t):
        return "annotation", {}
    if END.match(t):
        return "end", {}
    return "text", {}


ENTRY = re.compile(r"(?:^|(?<=[\s.]))(\d{1,3}[A-Z]{0,3})\s*\.\s+(?=[A-Z“\"‘(])")


def contents_entries(dropped):
    """The contents page -> {number: note}. OCR joins several lines into one paragraph ("3. Establishment of the
    Authority 4. Powers 15"), so every "N. Title" is read, in order, and only numbers running upwards are kept
    (a page number or a year in a title is not an entry)."""
    out, last = {}, (0, "")
    for p in dropped:
        t = p["text"].strip()
        ms = list(ENTRY.finditer(t))
        for i, m in enumerate(ms):
            n = num_key(m[1])
            if n > last and n[0] <= last[0] + 10:
                end = ms[i + 1].start() if i + 1 < len(ms) else len(t)
                out.setdefault(m[1], re.sub(r"\s+\d{1,4}\s*$", "", t[m.end():end]).strip(" .*"))
                last = n
    return out


NOTE_NO = re.compile(r"^\s*\(?(\d{1,3}[A-Z]{0,3})\)?\s*[.,]?\s*(.*)$", re.S)


def mend(paras):
    """Numbers the layout put in the wrong place, mended before the walk; only the next expected number counts:
      - in the margin note, not the body (the 1980 edition prints some section numbers in the margin): the
        paragraph opens with it;
      - inside another paragraph after a sentence end, two blocks merged ("... of that Act. 12. Any person ..."):
        the paragraph is cut there.
    The expected number is the last opener's + 1 (a jump of more than 10 does not move it)."""
    out, last, queue = [], 0, list(paras)
    # numbers some paragraph opens with: a split for one of them would make a second copy (cap:339's "18." inside s17)
    opens = {}
    for q in paras:
        if (m := OPENER.match(q["text"].strip())):
            opens[m[1]] = opens.get(m[1], 0) + 1
    while queue:
        p = queue.pop(0)
        t = p["text"].strip()
        m = OPENER.match(t)
        if m and m[1].isdigit():
            if 0 < int(m[1]) <= last + 10:
                last = int(m[1])
        elif (not m and p.get("note") and (nm := NOTE_NO.match(p["note"])) and nm[1].isdigit() and int(nm[1]) == last + 1
              and not re.match(r"of\s+\d{4}|\d", nm[2]) and str(last + 1) not in opens):    # not "17 of 1950", a history tag
            t = f"{nm[1]}. {t}"
            p = {**p, "text": t, "note": nm[2].strip() or None}
            last += 1
        nxt = re.search(rf"(?<=[.;:])\s+({last + 1})\s*\.\s+(?=[A-Z(])", t)
        if (last and nxt and nxt.start() >= 40 and len(t) - nxt.end() >= 40 and str(last + 1) not in opens
                and not p.get("rows") and " | " not in t):          # never inside a table (act:1/2015 "...:— 4. Head No. |")
            out.append({**p, "text": t[:nxt.start()]})
            queue.insert(0, {**p, "text": t[nxt.start():].strip(), "note": None})
            continue
        out.append(p)
    return out


def build(paras, prof, key=None):
    """paragraphs [{text, note, page?, rows?}] -> (tree, info). info holds what a check needs: the contents
    entries, rejected openers, headings that are not scopes, furniture dropped."""
    kept, n_contents = drop_contents(paras)
    kept = mend(kept)
    ids = {id(k) for k in kept}
    dropped = [p for p in paras if id(p) not in ids] if n_contents else []
    paras = kept
    first = next((i for i, p in enumerate(paras) if OPENER.match(p["text"].strip())), len(paras))
    furniture = [p for i, p in enumerate(paras) if i < first and FURNITURE.match(p["text"].strip())]
    paras = [p for i, p in enumerate(paras) if i >= first or not FURNITURE.match(p["text"].strip())]

    root = {"kind": "document", "children": []}
    front = {"kind": "front", "children": []}
    root["children"].append(front)
    cur, scope = front, root
    numbered = [p for p in paras if OPENER.match(p["text"].strip())]
    noteless = sum(bool(p["note"]) for p in numbered) < 0.1 * len(numbered)
    last, in_sched, parts, seen, head = (0, ""), False, prof["headings"], {}, None
    words = lambda ps: sum(len(re.findall(r"\w+", p["text"])) for p in ps)
    info = {"contents": contents_entries(dropped), "contents_dropped": len(dropped), "furniture_dropped": len(furniture),
            "dropped_words": words(dropped) + words(furniture), "rejected": [], "headings_not_scope": 0,
            "quoted_schedules": []}
    prev_letter, quoting, qnums, qsched, qpart, instruments, sched_last = None, False, set(), False, False, 1, 0

    def new(kind, label=None, under=None):
        nonlocal cur
        cur = {"kind": kind, "label": label, "note": None, "children": []}
        (under or scope)["children"].append(cur)
        return cur

    clean = lambda x: re.sub(r"^[.,·•]\s+(?=\d{1,3}[A-Z]{0,4}\s*\.\s)", "", x.strip())
    openers = [(i, num_key(m[1])) for i, q in enumerate(paras) if (m := OPENER.match(clean(q["text"])))]
    numbers = formula_numbers(paras, key)
    for at, p in enumerate(paras):
        # a stray mark before a section number (". 29. Section 161 ...", act:52/1998: OCR)
        t = clean(p["text"])
        m = None if p.get("rows") else OPENER.match(t)           # a table's first cell "4." opens nothing
        if m and re.match(r"[A-Z]?\s?\d{4,}", t[m.end() - 1:].lstrip()):
            m = None             # "1. E617568.778, N 491139.948": a survey point, not a provision (gazette:1964/02);
                                 # not "12. Sections 15, 16, 17 ..." (law:10/1974), which merely has many numbers
        rejected = quoted = restart = False
        if m:
            n = num_key(m[1])
            # a short jump needs evidence: its own note, a law printed without notes, or (gold set, act:1/2015 s5
            # after an opener OCR lost) an amending formula, "5. The Third Schedule to the principal enactment is hereby"
            # ... but not when one of the next openers fills the gap (OCR read s5 before s4, act:58/1981), nor for a
            # number the quoted formula named (the quoted "13. ... hereby amended", act:20/2013)
            nxt = [k for i, k in openers if i > at][:4]
            later = {k for i, k in openers if i > at}                # no jump over a number still to come (gazette:1940/21)
            amend_jump = (bool(AMEND.match(t[m.end() - 1:].lstrip())) and not (quoting and m[1] in qnums)
                          and not any(last < k < n for k in nxt))
            # ... or the numbers carry on from it: the next two openers are n+1 and n+2 (numbers lost before it,
            # gazette:2235/54 79, 80, 81 after 65), up to a jump of 50
            # (in a law with marginal notes the paragraph must have its own: a schedule's numbered amendments,
            # "12. In section 31A, by the substitution ...", carry on too, act:12/2005)
            chain = (not n[1] and nxt[:2] == [(n[0] + 1, ""), (n[0] + 2, "")] and n[0] <= last[0] + 50
                     and (bool(p["note"]) or noteless or not prof["notes"])
                     and not any(last < k < n for k in later))           # 26-29 read before 14 (act:12/2005)
            ok = n > last and (n[0] == last[0] if n[1] else
                               n[0] == last[0] + 1 or chain
                               or ((bool(p["note"]) or noteless or amend_jump) and n[0] <= last[0] + 10))
            # a schedule ends at the law's next section with its note, unless that number simply continues the
            # schedule's own list (act:12/2005: its schedule's lists run 1-5, then "6. In section 22 ..." is item 6)
            if in_sched and not (ok and p["note"] and not n[1] and n[0] != sched_last + 1):
                ok = False
                if not n[1]:
                    sched_last = n[0]
            if quoting:
                # inside text an amendment inserts ("... the following section substituted therefor:-" before it):
                # a number the sequence accepts is the law's own section (and ends the quote) unless the formula named
                # it and the paragraph is no amending formula itself, or its note opens a quote (an inserted section's)
                # an amending formula, or an amending note ("Amendment of section 4", "General Amendment to the
                # Principal Enactment", act:35/1998 s3), decides: own (act:36/1982 s4 had a quoted fragment as note)
                note = p["note"] or " "
                # (an amending note naming this paragraph's own number, "Replacement of section 29", is the formula's
                # note placed on the replacement text: act:3/1994's quoted s29)
                own = ((AMEND.match(t[m.end() - 1:].lstrip()) and (m[1] not in qnums or n == (last[0] + 1, "")))
                       or (AMENDING_NOTE.search(note) and note[0] not in QUOTES
                           and not re.search(rf"\bsections?\s*[,.]?\s*{re.escape(m[1])}\b", note, re.I))
                       or (m[1] not in qnums and note[0] not in QUOTES and n == (last[0] + 1, "")))
                # (a jump or 2B inside a quote is the inserted text: law:37/1974's quoted s11 after its own s3)
                if ok and own:
                    quoting = False
                else:
                    qnums.discard(m[1])
                    ok, quoted = False, True
            # numbering that starts again at 1 (gazettes: a second by-law, a Part's own regulations, gazette:1816/43): a
            # new instrument when the line reads like a provision, not like a form's numbered blank ("1. Name : ....")
            # (not when the next openers carry on the current numbers: a stray "1." mid-way, gazette:1898/04)
            restart = (not ok and not quoted and prof.get("restarts") and n == (1, "") and last[0] >= 2 and len(t) >= 60
                       and not re.search(r"\.{4,}|…{2,}|_{3,}|:\s*$", t[:120])
                       and not any(last < k <= (last[0] + 10, "~") for k in [k for i, k in openers if i > at][:4]))
            if restart:
                ok = True
            if not ok:
                m, rejected = None, not in_sched and not quoted
            else:
                last, in_sched = n, False
        sched = bool(SCHED_HEAD.match(t.lstrip("#* ")) and "SCHEDULE" in t[:80] and len(t) < 120)
        hm = HEADING.match(t)
        # a heading inside quoted text is quoted only if it opens with a quote mark or the formula named a Schedule
        # (for a schedule) or a Part/Chapter (for those); otherwise the quote has ended and the heading is the law's
        if quoting and (sched or hm) and not (t[:1] in QUOTES or (sched and qsched) or (hm and qpart)):
            quoting = False
        if quoting and sched:
            info["quoted_schedules"].append(sched_name(t.lstrip(QUOTES + " ")) or "Schedule")
        sched = sched and not quoting
        heading = bool(hm) and not in_sched and not quoting
        if parts and MID_PART.search(t):
            parts = head = None
            scope = root
        if heading and parts:
            kind, num = hm[1].title(), hm[2].upper()
            nm = re.fullmatch(r"(\d+)()|([IVXLC]+)([A-Z]?)", num)
            v = (int(nm[1]), "") if nm and nm[1] else (roman(nm[3]), nm[4]) if nm else None
            prev = seen.get(kind)
            if v and ((prev is None and v == (1, "")) or (prev and (v == (prev[0] + 1, "") or (v[0] == prev[0] and v[1] > prev[1])))):
                seen[kind] = v
                rest = re.sub(r"^[\s\-–—:.]+", "", t[hm.end():].replace("*", ""))
                title = re.sub(r"\s+", " ", rest.split("\n")[0]).strip()
                head = {"kind": "scope", "label": f"{kind} {num}",
                        "title": title if title and len(title) <= 100 and not re.search(r"\d", title) else None,
                        "children": []}
                root["children"].append(head)
                scope = head
            else:
                parts = head = None
                scope = root
        elif (head and cur is not None and cur.get("label") is None and cur["kind"] == "block" and not m and not sched
              and len(cur["children"]) == 1 and HEADING.match(cur["children"][0]["text"]) and not head["title"]
              and len(t) <= 100 and not re.search(r"\d|\.$", t)):
            head["title"] = re.sub(r"\s+", " ", t.replace("*", ""))        # the Part's title on the line after it
        if heading and not (head and scope is head):
            info["headings_not_scope"] += 1
        if m and restart:
            if not (head and scope is head and not any(c.get("kind") == "unit" for c in head["children"])):
                instruments += 1
                head = {"kind": "scope", "label": f"Instrument {instruments}", "title": None, "children": []}
                root["children"].append(head)
                scope = head
        if m or sched or heading:
            leads = (m and cur["kind"] == "block" and cur["label"] is None and cur["children"]
                     and HEADING.match(cur["children"][0]["text"]) and all(len(c["text"]) < 150 for c in cur["children"]))
            if leads:                                    # the heading's lines go into the unit after it
                cur["kind"], cur["label"] = "unit", m[1]
            elif m:
                new("unit", m[1])
            elif sched:
                head, scope, sched_last = None, root, 0
                new("schedule", sched_name(t) or "Schedule", under=root)
            else:
                new("block")
            in_sched = in_sched or sched
            if m:
                cur["note_on_opener"] = bool(p["note"])
        kind, extra = ("quote", {}) if quoting or quoted else kind_of(t, p, prev_letter)
        if kind == "item" and extra["level"] == 2:
            prev_letter = extra["marker"] if len(extra["marker"]) == 1 else None
        elif kind == "item" and extra["level"] == 1:
            prev_letter = None
        node = {"kind": "text" if (m and cur["children"] == []) else kind, "text": t, "page": p.get("page"), **extra}
        if p.get("rows"):
            node["rows"] = p["rows"]
        if p["note"]:
            node["note"] = p["note"]
        if rejected:
            node["rejected"] = True
            info["rejected"].append({"text": t[:120], "page": p.get("page"), "after": f"{last[0]}{last[1]}",
                                     "why": "in a schedule" if in_sched else "jump without a note" if num_key(OPENER.match(t)[1])[0] > last[0] + 1
                                     else "not after the last number"})
        cur["children"].append(node)
        if INTRO.search(t) and AMENDS.search(t):
            quoting, qnums = True, set(numbers.get(at, ()))
            qsched, qpart = bool(re.search(r"\b(?:Schedules?|Forms?)\b", t, re.I)), bool(re.search(r"\b(?:Parts?|Chapters?)\b", t))
        elif prof.get("amending") and not quoting and not m and quote_delta(t, False):
            # a quotation opened by its quote mark and not closed in this paragraph (“25A. ... with no formula
            # before it): the paragraphs after it are quoted too, until it closes or the law's own text resumes
            quoting, qnums, qsched, qpart = True, set(), False, False
        elif quoting and CLOSES.search(t):
            quoting = False
    return root, info


def units(tree):
    """Every unit and schedule in reading order, with the scope it is in."""
    for c in tree["children"]:
        if c["kind"] == "scope":
            for u in c["children"]:
                yield c, u
        else:
            yield None, c
