#!/usr/bin/env python3
"""Links from a chunk's flat text: a set of regexes run over all of it (marginal note, section text, quoted text,
anything). Every match is a link; only exact duplicates are dropped (decision 2026-10-10, user).

  operative  "Section(s) 5 [and 6] of <law> ... is/are hereby [further] amended|repealed [and ... substituted]"
  note form  "Amendment|Replacement|Repeal|Insertion|Substitution|Addition of [new] section(s) 5 of|in|to <law>"
  insert     "following new section(s) ... inserted|added ... (have|take) effect as section(s) 5A [, 5B] [of <law>]"
  substitute "There shall be substituted for section 5 of <law>"
  whole law  "<law> is/are hereby [further] amended|repealed"
  long title "AN ACT TO AMEND|REPEAL ... <law>"
  cites      "Act, No. 5 of 1990", "Act Nos, 5 of 1890, 3 of 1895", "(Chapter 26)", "the Penal Code", with the part
             named just before ("section 53 of the Penal Code")
<law> = "the principal enactment|Act|Law|Ordinance" (the last "hereinafter referred to as" read), "that enactment",
"the Constitution", a numbered law, "Chapter N", or a held law by its title.

  python3 -m etl.refs "Section 5 of the principal enactment is hereby repealed."   # what a text yields
"""
import re, sys

from etl import graph
from etl.graph import CHAP, PRINCIPAL, law_by_name, sched_names
from etl.structure import is_law_year

ITEM = r"\d{1,3}[A-Za-z]{0,5}"
SEP = r"(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*(?:to|-|–)\s*|\s+(?=\d))"
LIST = rf"{ITEM}(?:\s*\(\w{{1,5}}\))*(?:{SEP}(?:sections?\s*)?{ITEM}(?:\s*\(\w{{1,5}}\))*)*"
ORD = r"(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)"
PARTS = (rf"(?:(?<!sub)(?<!sub-)(?:sections?|articles?)\s*{LIST}"   # not "subsection 9 of section 31" -> 9
         rf"|(?:the\s+)?{ORD}(?:\s*(?:,|and)\s*{ORD})*\s+Schedules?|Schedules?\s+(?:[A-Z]{{1,2}}|[IVX]+|\d+)\b"
         rf"|(?:the\s+)?Schedule\b|(?:Part|Chapter)s?\s+[IVXL]+[A-Z]?(?:\s*(?:,|and)\s*[IVXL]+[A-Z]?)*\b|(?:the\s+)?long\s+title|(?:the\s+)?preamble)")
NAME = r"(?:[A-Z][\w’'-]*\s+(?:(?:of|and|for|the|in|on|to|\([^)]{1,40}\))\s+)*){1,12}?(?:Act|Law|Ordinance|Code|Order\s+in\s+Council)"
LAW = (rf"(?:the\s+)?principal\s+(?:enactment|Act|Law|Ordinance)|that\s+(?:enactment|Act|Law|Ordinance|Code)"
       rf"|the\s+Constitution|(?:the\s+)?{NAME}(?:,?\s*\(?\s*No[.,:]?\s*\d+\s*of\s*\d{{4}}\)?)?(?:\s*\((?:Chapter|Cap\.?)\s*\d+\w?\))?"
       rf"|(?:Act|Law|Ordinance)\W{{0,3}}No[.,:]?\s*\d+\s*of\s*\d{{4}}|Chapter\s+\d+")
# a gap inside one clause: not across a section opener ("PART VIII REPEALS 43. (1) The X Act ...", "Ordinance. 16. Section 26")
G = r"(?:(?!\s\d{1,3}[A-Z]{0,2}\.\s+[(A-Z]|\.\s+(?:[A-Z^*†]|\(\d))[^;:])"
PATTERNS = [
    ("operative", re.compile(rf"(?P<parts>{PARTS}){G}{{0,120}}?\b(?:of|to|in)\s+(?P<law>{LAW}){G}{{0,250}}?"
                             rf"\b(?:is|are)\s+(?:hereby\s+)?(?:further\s+)?(?P<verb>amended|repealed)"
                             rf"(?P<subst>[,\s]*and\s+(?:the\s+following|there\s+shall\s+be)[^.;]{{0,120}}?substituted)?", re.I)),
    ("note", re.compile(rf"\b(?P<verb>Amendment|Replacement|Substitution|Repeal|Insertion|Addition)s?\s+(?:of\s+|to\s+)?(?:new\s+)?"
                        rf"(?P<parts>{PARTS})\s+(?:of|in|to|into)\s+(?P<law>{LAW})", re.I)),
    ("insert", re.compile(rf"\bfollowing\s+(?:new\s+)?(?:heading\s+and\s+(?:new\s+)?)?(?:sections?|Parts?|Chapters?|Schedules?|Articles?)\b"
                          rf"[^.;]{{0,40}}?\b(?:is|are|shall\s+be)\s+(?:hereby\s+)?(?P<verb>inserted|added)[^;]{{0,250}}?"
                          rf"(?:have|take)\s+effect\s+(?:respectively\s+)?as\s+(?:the\s+)?(?P<parts>{PARTS})"
                          rf"(?:[^.;:]{{0,40}}?\b(?:of|in|to)\s+(?P<law>{LAW}))?", re.I)),
    ("substitute", re.compile(rf"\bthere\s+shall\s+be\s+(?P<verb>substituted)\s+for\s+(?P<parts>{PARTS})[^;:]{{0,60}}?\b(?:of|to|in)\s+(?P<law>{LAW})", re.I)),
    ("in_law", re.compile(rf"\bIn\s+(?P<law>{LAW})[^.;]{{0,100}}?\bthere\s+shall\s+be\s+(?P<verb>substituted)\b", re.I)),
    ("whole", re.compile(rf"(?<!\bof\s)(?P<law>{LAW}){G}{{0,160}}?\b(?:is|are)\s+(?:hereby\s+)?(?:further\s+)?(?P<verb>amended|repealed)\b", re.I)),
]
ALSO = re.compile(rf"\s*\(\s*((?:sections?|articles?)\s+{LIST})", re.I)     # "Part IXA (sections 801 to 833R)"
CITE_PART = re.compile(rf"(?P<parts>{PARTS})\s+(?:of|in|to|under)\s+(?P<law>(?:the\s+)?principal\s+(?:enactment|Act|Law|Ordinance)"
                       rf"|that\s+(?:enactment|Act|Law|Ordinance)|the\s+Constitution)", re.I)
CONST = re.compile(r"\bthe\s+Constitution\b")
AMENDED_BY = re.compile(r"\bas\s+(?:last\s+|further\s+)?amended\s+by\b|\bamended\s+by\b", re.I)
# what may follow "amended by" to the end of the phrase: only amending laws' numbers and joiners
AMENDERS = re.compile(r"(?:[\s\W\d]|\b(?:Acts?|Laws?|Ordinances?|Nos?|of|and|the|hereinafter|hereafter|in|this|Part)\b)*", re.I)
# a gazette's regulations or order and the Act section they are made under (issue #6): "Regulations made by the
# Minister under section 29 of the Foreign Exchange Act", "by virtue of the powers vested in me by section 3 of ..."
# "as per the powers vested upon me by the Section 66(1)(a) of Ceylon Petroleum Corporation Act", "in terms of the
# provisions of Section 2 (2) of the Entertainment Tax Ordinance" (real gazettes, 2026-10-20)
MADE_UNDER = re.compile(rf"\b(?:under|by|in\s+terms\s+of)\s+(?:the\s+)?(?:provisions?\s+of\s+)?(?P<parts>{PARTS})[^.;]{{0,60}}?"
                        rf"\b(?:of|in)\s+(?P<law>{LAW})", re.I)
# an extraordinary gazette by its number: "Gazette Extraordinary No. 1992/29", "Gaz. Ex. Ord. No. 471/6",
# "Extraordinary Gazette No. 2235/22" -> gazette:1992/29 (the listing pads the sub-number to two digits)
# "Gazette Extraordinary, No. 1595/14", "Gazette Extraordinary of the Democratic Socialist Republic of Sri Lanka No. 1234/5"
GAZ = re.compile(r"\b(?:Gazette\s*(?:\(?\s*Extra-?ordinary\s*\)?\s*)?|Gaz\.?\s*(?:Ext?r?a?\.?\s*(?:Ord(?:inary)?\.?\s*)?)?"
                 r"|Extra-?ordinary\s+Gazette\s*)[\s,]*(?:of\s+the\s+Democratic\s+Socialist\s+Republic\s+of\s+Sri\s+Lanka[\s,]*)?"
                 r"(?:Notification\s*)?(?:bearing\s+)?No[s.,:]?\s*(\d{3,4})\s*/\s*(\d{1,2})\b", re.I)
PRINC = re.compile(r"\bprincipal\s+(?:enactment|Act|Law|Ordinance)\b", re.I)
KIND = {"amendment": "amends", "amended": "amends", "replacement": "replaces", "substitution": "replaces",
        "substituted": "replaces", "repeal": "repeals", "repealed": "repeals", "insertion": "inserts",
        "inserted": "inserts", "addition": "inserts", "added": "inserts"}
# the kind word, then the number; between them OCR and layout put a stray figure, the chapter, or a margin word
# ("Pension Fund Ordinance (Chp. 431) No. 01 of 1898", "Criminal Procedure Act, Amendment of No. 15 of 1979")
CIT = re.compile(r"\b(Ac[its]s?|AC'T|Laws?|Ordinances?)\b(?:\W{0,3}|\s*\((?:Chp|Chapter|Cap)\.?\s*\d+\w?\)\s*"
                 r"|\W{1,3}(?:Amendment\s+of|of|Short\s+title\.|\d{1,3}\.)\s*)(?:\d{1,2}\s+)?\(?\s*Nos?\s*[.,:;-]?\s*(\d{1,4})\s*(?:of|0f)\s*(\d{4})", re.I)
# a number with no kind word, read only in Revised Edition chapters (title and history lines: "AN ORDINANCE FOR THE
# REGULATION OF CHAUFFEURS. No. 23 of 1912"); 87 in the corpus, 2026-10-11, the rest Regulations, Treaty Series, quotes
BARE = re.compile(r"\b[Nn][Oo][Ss]?\s*[.,:;-]?\s*(\d{1,4})\s*(?:of|OF|0f)\s*(\d{4})")
MORE = re.compile(r"\s*(?:,|and|&)\s*(?:No\.?\s*)?(\d{1,4})\s*(?:of|0f)\s*(\d{4})")      # "Nos. 5 of 1990 and 6 of 1991"
NAMED = re.compile(rf"\b[Tt]he\s+({NAME})\b")
Q = r"[“\"‘']([^”\"’]{0,300})[”\"’']"
OPS = [
    ("substitute", re.compile(rf"\bsubstitution,?\s+(?:in\s+[^,]{{0,60}},\s*)?for\s+(?:all\s+)?the\s+(?:words?|figures?|expression|letters?)"
                              rf"[^“\"‘]{{0,40}}{Q}.{{0,160}}?\bof\s+the\s+(?:words?|figures?|expression|letters?)[^“\"‘]{{0,40}}{Q}", re.I | re.S)),
    ("replace", re.compile(r"\brepeal\s+of\s+((?:the\s+)?(?:proviso\s+to\s+)?(?:sub-?)?(?:section|paragraph|clause)s?\s*\(\w{1,5}\))[^.;]{0,160}?substitution\s+therefor", re.I)),
    ("repeal", re.compile(rf"\brepeal\s+of\s+((?:the\s+)?(?:proviso\s+to\s+)?(?:sub-?)?(?:section|paragraph|clause)s?\s*\(\w{{1,5}}\)|the\s+definition\s+of\s+(?:the\s+expression\s+)?{Q})", re.I)),
    ("insert", re.compile(rf"\binsertion,?\s+(?:immediately\s+)?(after|before)\s+((?:the\s+)?(?:sub-?)?(?:section|paragraph|clause)\s*\(\w{{1,5}}\)|the\s+definition\s+of\s+{Q})", re.I)),
    ("add", re.compile(r"\baddition,?\s+(?:immediately\s+)?(after\s+(?:sub-?)?(?:section|paragraph)\s*\(\w{1,5}\)|at\s+the\s+end)", re.I)),
    ("omit", re.compile(rf"\bomission\s+(?:therefrom\s+)?of\s+(?:the\s+(?:words?|figures?)\s*{Q}|((?:sub-?)?(?:section|paragraph)\s*\(\w{{1,5}}\)))", re.I)),
]
LOC = re.compile(r"\bin\s+((?:the\s+proviso\s+to\s+)?(?:sub-?)?(?:section|paragraph)\s*\(\w{1,5}\)(?:\s+of\s+(?:that\s+)?(?:sub-?)?(?:section|paragraph)\s*(?:\(\w{1,5}\))?)*)", re.I)
NAMES = {}          # normalised title -> (key, tier), every held document (load_names)


def load_names(cur):
    """Every held law by its title: 1980 chapters (graph.CHAPTERS), then 1956 chapters, then non-amending Acts/Laws;
    a name two laws of one tier share is left out. An amending law is known by its long title too: lankalaw titles
    act:31/1988 "Inland Revenue" ("AN ACT TO AMEND THE INLAND REVENUE ACT"), and "the Inland Revenue Act" in a 1989
    Act went to it, not to 28/1979 (2026-10-20)."""
    tiers = [{n: {k} for n, k in graph.CHAPTERS.items()}, {}, {}]
    cur.execute("SELECT key, title, meta->>'long_title' FROM docs WHERE title IS NOT NULL")
    for k, t, lt in cur.fetchall():
        tier = 0 if k.startswith("cap:") else 1 if k.startswith("cap1956:") else 2
        if tier == 2 and (not re.match(r"(act|law|ordinance):", k) or re.search(r"amendment|appropriation", t, re.I)
                          or re.match(r"\s*AN?\s+(?:ACT|LAW|ORDINANCE)\s+TO\s+AMEND\b", lt or "", re.I)):
            continue
        if (n := graph.norm_name(re.sub(r",?\s*No\.?\s*\d+\s+of\s+\d{4}.*$", "", t, flags=re.I))):
            tiers[tier].setdefault(n, set()).add(k)
    NAMES.clear()
    for t in (2, 1, 0):          # chapters: a unique title only; Acts/Laws: every law of that title (by_name picks by year)
        NAMES.update({n: (sorted(ks, key=year_of), t) for n, ks in tiers[t].items() if t == 2 or len(ks) == 1})


def year_of(key):
    """act:4/1963 -> 1963; a 1980 chapter 1980, a 1956 chapter 1956; else None."""
    if (m := re.search(r"/(\d{4})$", key or "")):
        return int(m[1])
    return 1980 if (key or "").startswith("cap:") else 1956 if (key or "").startswith("cap1956:") else None


def by_name(text, before=None):
    """The held law whose title ends `text`, longest name first. Several Acts of one title: the newest passed by
    `before` (a 2006 Act's "Securities and Exchange Commission of Sri Lanka Act" is 36/1987, not 19/2021)."""
    text = re.sub(r",?\s*\(?\s*No[.,:]?\s*\d+\s*(?:of|0f)\s*\d{4}.*$|\s*\((?:Chapter|Cap)[^)]*\)?\s*$", "", text, flags=re.I | re.S)
    if not NAMES:
        return law_by_name(text, acts=True)
    words = re.findall(r"[A-Za-z’'-]+", text[-160:])
    for k in range(min(12, len(words)), 0, -1):
        hit = NAMES.get(graph.norm_name(" ".join(words[-k:])))
        if hit and (hit[1] < 2 or k > 1):
            keys = [x for x in hit[0] if not before or not re.search(r"/\d{4}$", x) or year_of(x) <= before]
            if hit[1] < 2 or len(hit[0]) == 1 or before:
                return keys[-1] if keys else None
    return None


def expand(s):
    """'65 to 73A' -> 65..73, 73A; '70F to 70N' -> 70F..70N without I and O (as drafted); '12A, 12B and 12C' -> each."""
    out, prev, rng = [], None, False
    for m in re.finditer(rf"({ITEM})|\b(to)\b|[-–]", re.sub(r"\(\w{1,5}\)", "", s), re.I):
        if not m[1]:
            rng = prev is not None
            continue
        n = m[1].upper()
        if rng:
            a, b = re.match(r"(\d+)([A-Z]*)", prev).groups(), re.match(r"(\d+)([A-Z]*)", n).groups()
            if a[0] == b[0] and len(a[1]) == 1 and len(b[1]) == 1:
                out += [f"{a[0]}{chr(c)}" for c in range(ord(a[1]) + 1, ord(b[1])) if chr(c) not in "IO"]
            elif 0 < int(b[0]) - int(a[0]) <= 200:            # ponytail: a wider "range" is OCR noise; ends only
                out += [str(i) for i in range(int(a[0]) + 1, int(b[0]) + (1 if b[1] else 0))]
        out.append(n)
        prev, rng = n, False
    return list(dict.fromkeys(out))


def labels(parts):
    """A PARTS match -> link labels: '5', 'First Schedule', 'Schedule C', 'Part IV', 'long title'."""
    if re.match(r"(?:sections?|articles?)", parts, re.I):
        return expand(re.sub(r"(?:sections?|articles?)", " ", parts, flags=re.I))
    if re.search(r"Schedule", parts, re.I):
        return (sched_names(parts) or [f"Schedule {x}" for x in re.findall(r"Schedules?\s+([A-Z]{1,2}|[IVX]+|\d+)\b", parts)]
                or ["Schedule"])
    if (m := re.match(r"(Part|Chapter)s?\s+(.+)", parts, re.I)):           # "Chapters II and IV" -> each
        return [f"{m[1].title()} {x.upper()}" for x in re.findall(r"[IVXL]+[A-Z]?", m[2], re.I)]
    return ["long title" if "title" in parts.lower() else "preamble"]


def num_key(kind, no, year):
    """kind None: from the year (Ordinances to 1947, Laws 1972-78, Acts otherwise)."""
    kind = kind or ("ordinance" if int(year) < 1948 else "act")
    kind = {"ac": "act", "la": "law", "or": "ordinance"}[kind[:2].lower()]
    no = f"{int(no)}/{year}"
    if kind == "law" and not 1972 <= int(year) <= 1978:
        kind = "act"
    return f"{'law' if kind == 'act' and is_law_year(no) else kind}:{no}"


def cites_in(t, bare=False):
    """Every numbered or chapter citation -> [(start, end, key)], list tails too ("Nos, 5 of 1890, 3 of 1895")."""
    out = []
    for m in CIT.finditer(t):
        out.append((m.start(), m.end(), num_key(m[1], m[2], m[3])))
        end = m.end()
        while (x := MORE.match(t, end)):
            out.append((x.start(), x.end(), num_key(m[1], x[1], x[2])))
            end = x.end()
    if bare:
        seen = [(a, b) for a, b, _ in out]
        out += [(m.start(), m.end(), num_key(None, m[1], m[2])) for m in BARE.finditer(t)
                if not any(a <= m.start() < b for a, b in seen) and not re.search(r"(?:Regulations?|Series|Agreement|Appeal|Gazette)\W{0,3}$", t[max(0, m.start() - 25):m.start()], re.I)]
    t = re.sub(r"\b(?:CHAPTER|CAP\.?)(?=\s*\d)", lambda m: m[0].title(), t)      # "(CHAPTER 101)"; same length
    return out + [(m.start(), m.end(), graph.key_of(m)) for m in CHAP.finditer(t)]


def ops(t):
    """The changes written after an amending clause: [{op, loc?, old?, new?, at?}]."""
    out, end = [], -1
    hits = sorted((m.start(), j, n, m) for j, (n, r) in enumerate(OPS) for m in r.finditer(t))
    locs = [(m.start(), re.sub(r"\s+", " ", m[1])) for m in LOC.finditer(t)]
    for start, _, n, m in hits:
        if start < end:
            continue
        end = m.end()
        op = {"op": n}
        if (loc := [l for p, l in locs if p < start]):
            op["loc"] = loc[-1]
        g = [re.sub(r"\s+", " ", x).strip() for x in m.groups() if x]
        if n == "substitute":
            op["old"], op["new"] = m[1].strip(), m[2].strip()
        elif n == "omit" and m[1]:
            op["old"] = g[0]
        elif g:
            op["at"] = " ".join(g)
        out.append(op)
    return out


class Doc:
    def __init__(self, key, long_title, texts):
        self.key, self.lt, self.year, self.unresolved = key, long_title or "", year_of(key), []
        graph._cite["le"], graph._cite["local"] = key.startswith("cap:"), {}
        graph._cite["old"] = bool(re.search(r"/19[0-5]\d$", key)) and int(key[-4:]) <= 1958
        for m in CHAP.finditer(" ".join([self.lt, *texts])):        # "Chapter 19" = the law this text names as Chapter 19
            if m[1] not in graph._cite["local"] and (hit := graph.chapter_by_name(m)):
                graph._cite["local"][m[1]] = hit
        self.principal = None
        lt_laws = self.lt_keys()
        self.principal = lt_laws[0] if len(lt_laws) == 1 else None

    def ok(self, keys):
        """No law amends or cites a law passed after it: such a number is a misprint (law:30/1978's CommonLII text
        defines its principal enactment as "Inland Revenue Act, No. 4 of 1983" for 4/1963)."""
        # a Revised Edition chapter is the old law consolidated, not a law of 1980: only numbered keys are dated
        return [k for k in keys if not (self.year and re.search(r"/\d{4}$", k) and year_of(k) > self.year)]

    def law(self, s):
        """A law phrase -> keys. A number passed after this law gives way to the name printed with it."""
        if re.match(r"(?:the\s+)?principal\b|that\b", s, re.I):
            return [self.principal] if self.principal else []
        if re.match(r"the\s+Constitution", s, re.I):
            return ["constitution"]
        keys = [k for *_, k in cites_in(s)]
        if (good := self.ok(keys)):
            return good
        if (k := by_name(s, self.year)) and self.ok([k]):
            return [k]
        if keys:
            self.unresolved.append((re.sub(r"\s+", " ", s)[:150], keys))
        return []

    def lt_keys(self):
        keys = self.ok([k for *_, k in cites_in(self.lt)]) or [k for x in NAMED.finditer(self.lt) if (k := by_name(x[1], self.year))]
        return keys + (["constitution"] if re.search(r"\bCONSTITUTION\b", self.lt[:80]) else [])

    def long_title_links(self):
        m = re.match(r"\s*AN?\s+(?:ACT|LAW)\s+(?:TO|FOR)\s+(?:\w+\s+){0,3}?(AMEND|REPEAL|PROVIDE\s+FOR\s+THE\s+REPEAL)", self.lt, re.I)
        if not m:
            return []
        # "AN ACT TO REPEAL SECTION 5 | PART IX | CERTAIN PROVISIONS OF ..." changes the law, it does not repeal it
        part = re.match(rf"\s+(?:OF\s+)?(?:AND\s+(?:RE-?ENACT|REPLACE|SUBSTITUTE)\s+)?(?:CERTAIN\s+)?(?:THE\s+)?(?:{PARTS}|PROVISIONS?|SO\s+MUCH)",
                        self.lt[m.end():], re.I)
        kind = "repeals_act" if "REPEAL" in m[1].upper() and not part else "amends_act"
        return [(None, kind, k, None, self.lt[:300], {"via": "long_title"}) for k in self.lt_keys()]

    @staticmethod
    def whole(t, m):
        """A "<law> is hereby amended|repealed" match is the whole law only if its clause names no part before it:
        "Section 5 of the principal enactment is hereby repealed" matched from "principal enactment" (issue #9)."""
        pre = re.split(r"[.;:\n]", t[max(0, m.start() - 300):m.start()])[-1]
        return not (re.match(r"(?:of|to|in)\s", m["law"], re.I) or re.search(rf"(?:so\s+much|{PARTS}|\b(?:sub-?)?(?:sections?|paragraphs?|clauses?|Articles?)\b)[^.;]{{0,40}}?\b(?:of|to|in)\s", m["law"], re.I) or re.search(r"\b(?:of|to|in)\s+(?:the\s+)?$", pre, re.I)
                    or re.search(rf"{PARTS}|\b(?:sub-?)?(?:sections?|paragraphs?|clauses?|provisions?|Schedules?|Tables?|Articles?)\b|\bso\s+much\b", pre, re.I))

    def chunk(self, i, t):
        out = []
        for m in PRINCIPAL.finditer(t):                # "(hereinafter referred to as the principal enactment)"
            w = t[max(0, m.start() - 300):m.start()]
            # "<law> as last amended by Act, No. 14 of 2004 (hereinafter ...)": the principal is <law>, not the amending
            # Act (24 laws, act:22/2012 -> 14/2004, 2026-10-20); only a clause that ends the phrase, not "Section 53, as
            # amended by Ordinance No. 24 of 1938, of the Ceylon State Mortgage Bank Ordinance"
            if (am := list(AMENDED_BY.finditer(w))) and AMENDERS.fullmatch(w[am[-1].end():]):
                w = w[:am[-1].start()]
            law = list(re.finditer(LAW, w))
            if law and (keys := self.law(law[-1][0])):
                self.principal = keys[-1]
        for name, r in PATTERNS:
            for m in r.finditer(t):
                if name == "whole" and not self.whole(t, m):
                    continue
                verb = m["verb"].lower()
                kind = "replaces" if name == "operative" and verb == "repealed" and m["subst"] else KIND[verb]
                laws = self.law(m["law"]) if m["law"] else ([self.principal] if self.principal else [])
                ctx = re.sub(r"\s+", " ", m[0]).strip()[:300]
                det = {"via": name}
                if kind == "amends":
                    det["ops"] = ops(t[m.end():m.end() + 600])
                if name in ("whole", "in_law"):
                    if name == "in_law":
                        det["ops"] = ops(t[m.start():m.end() + 600])
                    out += [(i, ("amends" if name == "in_law" else kind) + "_act", k, None, ctx, det) for k in laws]
                else:
                    # "Part IXA (sections 801 to 833R both inclusive) of", "Chapter VIIA of the Constitution (Articles 41A to 41H)"
                    ls = labels(m["parts"])
                    if name == "operative" and re.match(r"(?:Part|Chapter)\b", m["parts"], re.I):
                        ls += [l for e in ("parts", "law") if (x := ALSO.match(t, m.end(e))) for l in labels(x[1])]
                    out += [(i, kind, k, l, ctx, det) for k in laws for l in ls]
        for m in CITE_PART.finditer(t):                # "Article 154 of the Constitution", "section 127 of the principal Act"
            ctx = re.sub(r"\s+", " ", t[max(0, m.start() - 80):m.end() + 120]).strip()
            out += [(i, "cites", k, l, ctx, {"via": "cite"}) for k in self.law(m["law"]) for l in labels(m["parts"])]
        if self.principal:                             # "under the principal enactment", "amendment made to the principal enactment"
            out += [(i, "cites", self.principal, None, re.sub(r"\s+", " ", t[max(0, m.start() - 120):m.end() + 120]).strip(), {"via": "cite"})
                    for m in PRINC.finditer(t)]
        if self.key.startswith("gazette:"):
            for m in MADE_UNDER.finditer(t):
                ctx = re.sub(r"\s+", " ", t[max(0, m.start() - 80):m.end() + 80]).strip()
                out += [(i, "made_under", k, l, ctx, {"via": "made_under"}) for k in self.law(m["law"]) for l in labels(m["parts"])]
        for m in GAZ.finditer(t):
            k = f"gazette:{m[1]}/{int(m[2]):02d}"
            if k == self.key:
                continue
            # the verb of the clause the number sits in: "the Order published in Gaz. Ex. No. 1992/29 ... is hereby rescinded"
            end = r"(?<!No)(?<!Nos)(?<!Gaz)(?<!Ex)(?<!Ord)(?<!Sec)(?<!Cap)[.;]\s"      # not "No. ", "Gaz. Ex. "
            w = re.split(end, t[max(0, m.start() - 160):m.start()])[-1] + m[0] + re.split(end, t[m.end():m.end() + 160])[0]
            kind = "rescinds" if re.search(r"rescind|revok|cancel", w, re.I) else "amends" if re.search(r"\bamend|\brepeal|substitut", w, re.I) else "cites"
            out.append((i, kind, k, None, re.sub(r"\s+", " ", t[max(0, m.start() - 120):m.end() + 80]).strip(), {"via": "gazette"}))
        out += [(i, "cites", "constitution", None, re.sub(r"\s+", " ", t[max(0, m.start() - 80):m.end() + 80]).strip(), {"via": "cite"})
                for m in CONST.finditer(t)]
        nums = cites_in(t, bare=self.key.startswith("cap"))
        # a name printed with its number is the number's link only: "the Finance Act, No. 11 of 1963" also gave
        # law:47/1973 "Finance Law" by name (28 links, 2026-10-20); a misprinted number (fails ok()) leaves the name
        dated = [s for s, _, k in nums if re.search(r"/\d{4}$", k) and self.ok([k])]
        named = [(m.start(), m.end(), by_name(m[1], self.year)) for m in NAMED.finditer(t)
                 if not any(m.start() <= s <= m.end() + 5 for s in dated)]
        for s, e, k in nums + named:
            if not k or not self.ok([k]):
                continue
            before = re.search(rf"({PARTS})[^.;]{{0,40}}?\b(?:of|in|under|to)\s+(?:the\s+)?[^.;]{{0,100}}$", t[max(0, s - 180):s], re.I)
            # "Section 10 of the principal enactment as amended by Act No. 39 of 1983": s10 is the principal's, not 39/1983's
            if before and re.search(r"\bprincipal\b|\bamended\s+by\b|\bthat\s+(?:enactment|Act|Law|Ordinance)\b",
                                    t[max(0, s - 180):s][before.end(1):], re.I):
                before = None
            kind = "consolidates" if self.key.startswith("cap") and i == 0 else "cites"
            ctx = re.sub(r"\s+", " ", t[max(0, s - 120):e + 40]).strip()
            out += [(i, kind, k, l, ctx, {"via": "cite"}) for l in (labels(before[1]) if before else [None])]
        return out


def links(key, long_title, texts, unresolved=None):
    """A law's chunks (texts, in order) -> [(chunk index or None, kind, dst, dst_label, context, detail)].
    unresolved: a list that gets the law phrases whose number was impossible and whose name found nothing."""
    d = Doc(key, long_title, texts)
    out = d.long_title_links()
    for i, t in enumerate(texts):
        out += d.chunk(i, t)
    if unresolved is not None:
        unresolved += d.unresolved
    seen, uniq = set(), []
    for o in out:
        # a consolidated Constitution (constitution:N) citing "the Constitution" cites itself
        if o[2] and o[2] != key and not (o[2] == "constitution" and key.startswith("constitution:")) and (k := o[:4]) not in seen:
            seen.add(k)
            uniq.append(o)
    return uniq


if __name__ == "__main__":
    for o in links("act:1/2099", "", [sys.argv[1]]):
        print(o)
