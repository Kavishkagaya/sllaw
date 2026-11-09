#!/usr/bin/env python3
"""Mentions: every citation in a law's text as one record (docs/LINKS.md). Built on etl/refs.py's patterns, which
stay as they are (the structure build reads refs.py, and a change there would rebuild every document).

A mention = one span of chunk text: what it does (relation), how much of the target (scope), how the law is written
(law_form), the law (dst_doc, or dst_name when not identified), the provisions named (unit, labels, sub), whether it
is inside quoted inserted text, and a rule-based confidence. Resolving labels to chunks is `resolve`'s job (SQL);
here only the law is decided, since that needs the name index and the text around the citation.

  python3 -m etl.mentions "Section 5 of the said Act is hereby repealed."     # what a text yields
"""
import re, sys

from etl import graph, refs
from etl.refs import CHAP, G, KIND, LIST, ORD, PARTS, by_name, cites_in, labels, num_key, ops, year_of

KW = r"(?:enactment|Act|Law|Ordinance|Code|Statute)"
KW_C = r"(?:enactment|Act|Ordinance|(?-i:Law|Code|Statute))"           # "that law" is generic; "that Law" a law
ANAPH = rf"(?:the\s+)?(?:said|aforesaid|same|above[-\s]?mentioned|last[-\s]?mentioned)\s+{KW_C}\b|that\s+{KW_C}\b"
THIS = r"this\s+(?:Act|Law|Ordinance|Code|Statute)\b"
DEF = r"the\s+(?-i:Act|Law|Ordinance|Code)\b(?!\s*,?\s*No\b)(?!\s+of\s)(?!\s*\()(?!\s+(?-i:[A-Z]))"
# refs.LAW plus: anaphora, this Act, "Constitution" without "the", a defined short name ("the Code")
LAW2 = rf"{ANAPH}|{THIS}|Constitution\b|{refs.LAW}|{DEF}"
PATTERNS = [(n, re.compile(r.pattern.replace(refs.LAW, LAW2), r.flags)) for n, r in refs.PATTERNS]
CITE_PART = re.compile(rf"(?P<parts>{PARTS})\s+(?:of|in|to|under)\s+(?P<law>(?:the\s+)?principal\s+(?:enactment|Act|Law|Ordinance)"
                       rf"|{ANAPH}|{THIS}|(?:the\s+)?Constitution\b|{DEF})", re.I)
MADE_UNDER = re.compile(refs.MADE_UNDER.pattern.replace(refs.LAW, LAW2), refs.MADE_UNDER.flags)
LAWWORD = re.compile(rf"\b(?:{ANAPH}|{THIS}|{DEF})", re.I)
# a name with no "the" after a preposition ("of Code of Criminal Procedure Act"), and one in capitals
NAMED_P = re.compile(r"\b(?:of|under|in|to|by)\s+((?:[A-Z][\w’'-]*\s+(?:(?:of|and|for|the|in|on|to)\s+)*){1,12}?(?:Act|Law|Ordinance|Code))\b")
# a name opening a list item or line ("SCHEDULE Part I 1. Excise Ordinance (Cap. 52)", repeal schedules)
NAMED_L = re.compile(r"(?:^|\n|\b\d{1,3}\.\s+|;\s+|\|\s*)((?:[A-Z][\w’'-]*\s+(?:(?:of|and|for|the|in|on|to|\([^)]{1,40}\))\s+)*){1,12}?(?:Act|Law|Ordinance|Code))\b")
# "under s. 24 of the Act", "Sec. 77(5)(a) of the Act" (gazettes)
ABBR = re.compile(rf"\b(?:Secs?|SECS?|ss?)\.\s*(?P<labs>{LIST})(?:\s*\(\w{{1,5}}\))*\s*(?:of|in|under)\s+(?P<law>{LAW2})")
NAMED_C = re.compile(r"\bTHE\s+((?:[A-Z][A-Z’'(),&-]*[ \t]+){1,12}?(?:ACT|LAW|ORDINANCE|CODE))\b")
# numbers refs.CIT misses: "Act No.13/2005", "Act, No. 33, of 1961"
CIT2 = re.compile(r"\b(Acts?|Laws?|Ordinances?)\W{0,3}No[s.,:]?\s*(\d{1,4})\s*(?:,\s*of|/)\s*(\d{4})\b", re.I)
# Provincial Council Statutes (none held): "Western Province Sports Statute, No. 01 of 1993"
STATUTE = re.compile(r"((?:[A-Z][\w’'()-]*\s+){0,10})Statutes?\W{0,3}No[s.,:]?\s*(\d{1,4})\s*(?:of|0f|/)\s*(\d{4})")
# the Nth Amendment to the Constitution, with the section of it ("Sec. 2(a)", "Section 2 (b) of the Thirteenth ...")
ORDS = {w: i + 1 for i, w in enumerate(
    "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth "
    "fifteenth sixteenth seventeenth eighteenth nineteenth twentieth".split())}
ORDW = r"(?:Twenty[-\s]?(?:First|Second|Third)|" + "|".join(ORDS) + r"|\d{1,2}(?:st|nd|rd|th))"
AMEND_C = re.compile(rf"\b(?P<ord>{ORDW})\s+Amendment\s+(?:to|of)\s+the\s+Constitution\b", re.I)
SEC_BEFORE = re.compile(r"\b(?:Section|Sec\.?|s\.)\s*(\d{1,3}[A-Z]?)(?:\s*\(\w{1,4}\))*\s+of\s+(?:the\s+)?$", re.I)
SEC_AFTER = re.compile(r"\s*,?\s*(?:Section|Sec\.?|s\.)\s*,?\s*(\d{1,3}[A-Z]?)\b", re.I)
# gazettes refs.GAZ misses: "No. 14,752/1", "Notifications No. 1681/5 ... and 1686/43", "Gazette of the ... Extraordinary
# No.", old ordinary gazettes "Gazette No. 10,132 of August 1, 1950" (keyed gazette:10132, never held)
GAZ2 = re.compile(r"\b(?:Government\s+)?(?:Gazette|Gaz\.)(?:\s*\(?\s*Extra-?\s?ordinary\s*\)?)?(?:\s*,?\s*of\s+the\s+Democratic\s+Socialist"
                  r"\s+Republic\s+of\s+Sri\s+Lanka)?(?:\s*\(?\s*Extra-?\s?ordinary\s*\)?)?[\s,]*(?:Notifications?\s*)?(?:bearing\s+)?"
                  r"(?:No[s.,:]?|number)\s*(\d{1,2},\d{3}|\d{3,5})(?:\s*/\s*(\d{1,2}))?", re.I)
GAZ_MORE = re.compile(r"(?:\s*(?:of|dated)\s+[\w.,\s]{4,24}?)?\s*(?:,|and|&)\s*(\d{3,4})\s*/\s*(\d{1,2})\b")
# a bare section or Article: not followed by "of/in/to <a law>" (then a pattern above reads it)
LIST_OR = LIST.replace(r"|\s+and\s+|", r"|\s+and\s+|\s+or\s+|").replace(r"(?:sections?\s*)?", r"(?:(?:sections?|articles?)\s*)?")
BARE = re.compile(rf"(?<![\w-])(?<!sub)(?<!sub-)(?P<parts>(?:sections?|Articles?)\s*{LIST_OR})", re.I)
# the part right before a law phrase ("section 7 of the said Act"), nothing between but the sub-path
TIGHT = re.compile(rf"(?<!sub)(?<!sub-)\b((?:sections?|articles?)\s*{LIST_OR}|{PARTS})(?:\s*\(\w{{1,5}}\))*\s*,?\s+(?:of|in|under|to)\s+$", re.I)
FOLLOW = re.compile(r"\s*(?:\([\w ]{1,12}\)\s*)*(?i:of|in|to|under)\s+(?:(?i:the|that|this|any|such|an?)\b|[A-Z(])")
PRIORITY = {"operative": 0, "note": 0, "insert": 0, "substitute": 0, "in_law": 0, "whole": 1, "long_title": 1,
            "made_under": 2, "amendment": 2, "gazette": 2, "statute": 2, "cite": 3, "phrase": 3, "named": 3,
            "principal": 5, "constitution": 5, "bare": 6}
HIGH = {"number", "chapter", "principal", "defined", "constitution", "amendment", "gazette", "statute"}


def unit_of(parts):
    p = parts.lower().lstrip()
    for u in ("section", "article", "schedule", "part", "chapter"):
        if p.startswith(u) or (u == "schedule" and "schedule" in p):
            return u
    return "title"


def scope_of(unit):
    return {"section": "provision", "article": "provision", "schedule": "schedule", "part": "part",
            "chapter": "part", "title": "title"}.get(unit, "whole_law")


def sub_of(parts):
    """'section 5 (2) (a)' -> '(2)(a)'; only for one provision."""
    m = re.match(rf"\s*(?:sections?|articles?)\s*[,.]?\s*\d{{1,3}}[A-Za-z]{{0,5}}((?:\s*\(\w{{1,5}}\))+)\s*$", parts, re.I)
    return re.sub(r"\s+", "", m[1]) if m else None


def kindword(s):
    m = re.findall(r"\b(Act|Law|Ordinance|Code|Statute|Chapter|Cap)\b", s, re.I)
    w = m[-1].title() if m else None
    return "Ordinance" if w in ("Chapter", "Cap") else w


def labels_ok_chapter(t, s, e, key):
    """A chapter number cites a law only with a law's name or a bracket before it ("Customs Ordinance (Chapter 235)",
    "Repeal of Chapter 236"); a gazette's bare "Chapter 46 Manufactures of straw" is a customs tariff chapter."""
    if not key.startswith("gazette:"):
        return True
    return bool(re.search(r"(?:\(|\b(?:Act|Law|Ordinance|Code|of|under)\b[\s,]*\(?)\s*$", t[max(0, s - 40):s], re.I))


def law_kind(t, s, e):
    """The kind word of a cited law: in its span ("Act, No. 9 of 1950"), else the name before "(Chapter 101)"."""
    m = re.findall(r"\b(Act|Law|Ordinance|Code|Statute)\b", t[s:e], re.I)
    if m:
        return m[-1].title()
    m = re.findall(r"\b(Act|Law|Ordinance|Code|Statute)\b", t[max(0, s - 80):s], re.I)
    return m[-1].title() if m else None


def amend_no(o):
    """'Thirteenth' / 'Twenty-first' / '13th' -> 13 / 21 / 13."""
    o = re.sub(r"[-\s]+", " ", o.lower())
    if (m := re.match(r"(\d+)", o)):
        return int(m[1])
    if o.startswith("twenty "):
        return 20 + {"first": 1, "second": 2, "third": 3}.get(o.split()[1], 0)
    return ORDS.get(o)


class Doc(refs.Doc):
    def __init__(self, key, long_title, texts, held=None):
        super().__init__(key, long_title, texts)
        self.held = held                       # set of held keys (None: not checked here)
        self.defined = {}                      # "the code" -> key
        self.last = []                         # laws named so far in the document, in order: (kindword, key)
        self.amending = bool(re.match(r"\s*AN?\s+(?:ACT|LAW|ORDINANCE)\s+(?:TO|FOR)\s+(?:\w+\s+){0,3}?AMEND", self.lt, re.I))
        self.family = key.startswith(("constitution", "amendment:"))

    # -- the law a phrase names --------------------------------------------------------------------------------
    def law2(self, s, seen, pos):
        """-> (law_form, dst_type, keys, confidence)."""
        s1 = re.sub(r"\s+", " ", s.strip())
        if re.match(r"(?:the\s+)?principal\b", s1, re.I):
            return "principal", "law", ([self.principal] if self.principal else []), "high"
        if re.match(ANAPH, s1, re.I):
            w = kindword(s1) or "enactment"
            cands = [k for p, kw, k in seen if p < pos and (w.lower() == "enactment" or (kw or "").lower() == w.lower())]
            if cands:
                if cands[-1] is None:
                    return "anaphora", "law", [], "low"
                return "anaphora", "law", [cands[-1]], "medium" if len(set(cands)) == 1 else "low"
            p = self.principal if self.principal and self.principal != "constitution" else None
            if p and self.amending:
                return "anaphora", "law", [p], "medium"
            prev = [k for kw, k in self.last if w.lower() == "enactment" or (kw or "").lower() == w.lower()]
            if prev:
                return "anaphora", "law", prev[-1:], "low"
            return "anaphora", "law", ([p] if p else []), "low"
        if re.match(THIS, s1, re.I):
            if self.amending and self.principal and self.principal != "constitution" and self.in_quote(self.text, pos):
                return "principal", "law", [self.principal], "medium"
            return "this_law", "self", [self.key], "high"
        if re.match(r"(?:the\s+)?Constitution\b", s1, re.I):
            return "constitution", "constitution", ["constitution"], "high"
        if re.fullmatch(DEF, s1, re.I):
            k = self.defined.get(s1.lower().replace("the ", "", 1))
            if k:
                return "defined", "law", [k], "high"
            if self.key.startswith("gazette:"):
                w = kindword(s1)
                prev = [x for p, kw, x in seen if p < pos and kw == w and x] or [x for kw, x in self.last if kw == w]
                return "anaphora", "law", prev[-1:], "low"
            return "defined", "law", [], "low"
        keys = self.law(s1)
        nums = [k for *_, k in cites_in(s1)]
        if any(re.search(r"/\d{4}$", k) for k in nums) and keys and keys[0] in nums:
            return "number", "law", keys, "high"
        if nums and keys and keys[0] in nums:
            return "chapter", "law", keys, "high"
        hit = refs.NAMES.get(graph.norm_name(s1))
        return "name", "law", keys, ("low" if hit and len(hit[0]) > 1 else "medium")

    def definitions(self, t):
        """'(hereinafter referred to as "the Code")', '"the Act" means the Parliamentary Elections Act'."""
        for m in re.finditer(r"referred\s+to\s+as\s+(?:the\s+)?['‘’\"“”]{1,2}\s*(?:the\s+)?(Act|Law|Ordinance|Code)\s*['‘’\"“”]{1,2}", t, re.I):
            w = t[max(0, m.start() - 300):m.start()]
            law = list(re.finditer(refs.LAW, w))
            if law and (keys := self.law(law[-1][0])):
                self.defined[m[1].lower()] = keys[-1]
        for m in re.finditer(rf"['‘\"“]{{1,2}}\s*(?:the\s+)?(Act|Law|Ordinance|Code)\s*['’\"”]{{1,2}}\s+means\s+(?P<law>{refs.LAW})", t):
            if (keys := self.law(m["law"])):
                self.defined[m[1].lower()] = keys[-1]

    # -- one chunk ---------------------------------------------------------------------------------------------
    def mentions(self, i, t):
        out = []
        # "section 27 A (1)" -> "section 27A  (1)": the letter joins the number, the length stays (offsets hold)
        t = re.sub(r"(?<=\d) ([A-Z])(?=\s*[(,]|\s+(?:of|and|or|to)\b)", r"\1 ", t)
        self.text = t
        self.chunk_principal(t)
        self.definitions(t)
        tn = re.sub(r"(?<=Chapter)\.", " ", re.sub(r"(?<=\d),(?=\s*of\s+\d{4})", " ", t))     # same length
        nums = cites_in(tn, bare=self.key.startswith("cap"))
        nums += [(m.start(), m.end(), num_key(m[1], m[2], m[3])) for m in CIT2.finditer(t)]
        named, unknown = [], []
        for r in (refs.NAMED, NAMED_P, NAMED_C, NAMED_L):
            for m in r.finditer(t):
                if any(a <= m.start(1) < b or a < m.end(1) <= b for a, b, _ in nums + named + unknown):
                    continue
                if (k := by_name(m[1], self.year)) and self.ok([k]):
                    named.append((m.start(1), m.end(1), k))
                elif r is refs.NAMED:
                    unknown.append((m.start(1), m.end(1), None))     # a law we do not hold: "that Ordinance" may mean it
        # the laws named so far, in order; an unknown one stops "that Ordinance" reaching back past it to a wrong law
        seen = sorted(((s, law_kind(t, s, e), k) for s, e, k in nums + named + unknown), key=lambda x: x[0])

        def add(m_start, m_end, relation, scope, form, dtype, keys, conf, via, unit=None, labs=None, sub=None, ops_=None,
                law_text=None, name=None):
            span = re.sub(r"\s+", " ", t[m_start:m_end]).strip()
            if unit in ("part", "chapter"):            # "part is formed": a Part is an upper-case numeral as printed
                labs = [l for l in labs or [] if not re.match(r"(?:Part|Chapter)\s", l)
                        or re.search(rf"\b{re.escape(l.split()[-1])}\b", t[m_start:m_end])]
                if not labs:
                    return
            if re.match(r"\W*(?:Chapter|Cap)\b", t[m_start:m_end], re.I) and not labels_ok_chapter(t, m_start, m_end, self.key):
                return                                  # a customs tariff chapter in a gazette
            if dtype == "law" and not keys and via in ("phrase", "cite") and form in ("anaphora", "defined"):
                return                                  # "the Act" nobody defined: nothing to show
            base = dict(i=i, start=m_start, end=m_end, span=span[:300], relation=relation, scope=scope, law_form=form,
                        law_text=law_text, dst_type=dtype, unit=unit, labels=labs or [], sub=sub, confidence=conf,
                        via=via, ops=ops_, in_quote=self.in_quote(t, m_start), context=re.sub(r"\s+", " ", t[max(0, m_start - 120):m_end + 80]).strip())
            if keys:
                out.extend(dict(base, dst_doc=k, dst_name=None) for k in dict.fromkeys(keys))
            else:
                out.append(dict(base, dst_doc=None, dst_name=re.sub(r"\s+", " ", name or law_text or "")[:200] or None))

        # 1 change patterns (refs.PATTERNS with the wider law phrase)
        for name, r in PATTERNS:
            for m in r.finditer(t):
                if name == "whole" and not self.whole(t, m):
                    continue
                verb = m["verb"].lower()
                rel = "replaces" if name == "operative" and verb == "repealed" and m["subst"] else KIND[verb]
                if m["law"]:
                    form, dtype, keys, conf = self.law2(m["law"], seen, m.start("law"))
                else:
                    form, dtype, keys, conf = "principal", "law", ([self.principal] if self.principal else []), "medium"
                det = ops(t[m.end():m.end() + 600]) if rel == "amends" else None
                if name in ("whole", "in_law"):
                    if name == "in_law":
                        det = ops(t[m.start():m.end() + 600])
                    add(m.start(), m.end(), "amends" if name == "in_law" else rel, "whole_law", form, dtype, keys, conf, name,
                        ops_=det, law_text=m["law"])
                    continue
                parts, ls = m["parts"], labels(m["parts"])
                if name == "operative" and re.match(r"(?:Part|Chapter)\b", parts, re.I):
                    ls += [l for e in ("parts", "law") if (x := refs.ALSO.match(t, m.end(e))) for l in labels(x[1])]
                u = unit_of(parts)
                add(m.start(), m.end(), rel, scope_of(u), form, dtype, keys, conf, name, u, ls, sub_of(parts), det, m["law"])
        # 2 a part of the principal enactment, of "the said Act", of this Act, of the Constitution
        for m in CITE_PART.finditer(t):
            form, dtype, keys, conf = self.law2(m["law"], seen, m.start("law"))
            u = unit_of(m["parts"])
            add(m.start(), m.end(), "cites", scope_of(u), form, dtype, keys, conf, "cite", u, labels(m["parts"]),
                sub_of(m["parts"]), law_text=m["law"])
        for m in ABBR.finditer(t):
            form, dtype, keys, conf = self.law2(m["law"], seen, m.start("law"))
            add(m.start(), m.end(), "cites", "provision", form, dtype, keys, conf, "cite", "section", refs.expand(m["labs"]),
                law_text=m["law"])
        # 3 regulations made under a provision (gazettes)
        if self.key.startswith("gazette:"):
            for m in MADE_UNDER.finditer(t):
                form, dtype, keys, conf = self.law2(m["law"], seen, m.start("law"))
                u = unit_of(m["parts"])
                add(m.start(), m.end(), "made_under", scope_of(u), form, dtype, keys, conf, "made_under", u,
                    labels(m["parts"]), sub_of(m["parts"]), law_text=m["law"])
        # 4 gazettes (refs.GAZ, then the wider GAZ2, lists after either)
        gz = []
        for r in (refs.GAZ, GAZ2):
            for m in r.finditer(t):
                if any(a <= m.start() < b for a, b, _ in gz):
                    continue
                no = m[1].replace(",", "")
                ks = [f"gazette:{no}/{int(m[2]):02d}" if m[2] else f"gazette:{no}"]
                end = m.end()
                while (x := GAZ_MORE.match(t, end)):
                    ks.append(f"gazette:{x[1]}/{int(x[2]):02d}")
                    end = x.end()
                gz.append((m.start(), end, ks))
        for s, e, ks in gz:
            stop = r"(?<!No)(?<!Nos)(?<!Gaz)(?<!Ex)(?<!Ord)(?<!Sec)(?<!Cap)[.;]\s"
            w = re.split(stop, t[max(0, s - 160):s])[-1] + t[s:e] + re.split(stop, t[e:e + 160])[0]
            rel = "rescinds" if re.search(r"rescind|revok|cancel", w, re.I) else "amends" if re.search(r"\bamend|\brepeal|substitut", w, re.I) else "cites"
            add(s, e, rel, "whole_law", "gazette", "gazette", [k for k in ks if k != self.key], "low" if rel != "cites" else "high", "gazette")
        # 5 Amendments to the Constitution, with the section of the amendment when given
        for m in AMEND_C.finditer(t):
            if not (n := amend_no(m["ord"])) or f"amendment:{n}" == self.key:
                continue
            w0 = max(0, m.start() - 40)
            s0, e0, sec = m.start(), m.end(), None
            if (b := SEC_BEFORE.search(t[w0:m.start()])):
                s0, sec = w0 + b.start(), b[1]
            elif (a := SEC_AFTER.match(t, m.end())):
                e0, sec = a.end(), a[1]
            add(s0, e0, "cites", "provision" if sec else "whole_law", "amendment", "amendment", [f"amendment:{n}"], "high",
                "amendment", "section" if sec else None, [sec.upper()] if sec else None)
        # 6 Provincial Statutes (never held: a mention by name and number)
        for m in STATUTE.finditer(t):
            add(m.start(), m.end(), "cites", "whole_law", "statute", "statute", [], "high", "statute",
                name=f"{m[1].strip()} Statute No. {int(m[2])} of {m[3]}".strip())
        # 7 a law cited by number, chapter, name, or as "the said Act" / "this Act" / "the Code", with the part named
        # just before it ("section 53 of the Penal Code")
        phrases = [(s, e, None, k) for s, e, k in nums + named]
        for m in LAWWORD.finditer(t):
            phrases.append((m.start(), m.end(), m[0], None))
        for s, e, phrase, k in phrases:
            if phrase:
                form, dtype, keys, conf = self.law2(phrase, seen, s)
            else:
                if not self.ok([k]):
                    continue
                form = "number" if re.search(r"/\d{4}$", k) else "chapter" if re.match(r"\W*(?:Chapter|Cap)", t[s:e], re.I) else "name"
                hit = refs.NAMES.get(graph.norm_name(t[s:e])) if form == "name" else None
                dtype, keys, conf = "law", [k], "low" if hit and len(hit[0]) > 1 else "medium" if form == "name" else "high"
            if phrase:
                before = TIGHT.search(t[max(0, s - 180):s])
                if not before and t[max(0, s - 2):s].strip()[-1:] in "“\"‘'" and t[max(0, s - 2):s].strip():
                    continue                                # the defined name inside its own definition
            else:
                before = re.search(rf"({PARTS})[^.;]{{0,40}}?\b(?:of|in|under|to)\s+(?:the\s+)?[^.;]{{0,100}}$", t[max(0, s - 180):s], re.I)
                if before and re.search(r"\bprincipal\b|\bamended\s+by\b|\bthat\s+(?:enactment|Act|Law|Ordinance)\b|\bsaid\b|\baforesaid\b|\bthis\s+(?:Act|Law|Ordinance)\b",
                                        t[max(0, s - 180):s][before.end(1):], re.I):
                    before = None
            if phrase and not before and form == "this_law":
                continue                                    # "this Act" alone: the law itself, no link wanted
            kind = "consolidates" if self.key.startswith("cap") and i == 0 and not phrase else "cites"
            if before:
                u = unit_of(before[1])
                bs = max(0, s - 180) + before.start(1)
                add(bs, e, kind, scope_of(u), form, dtype, keys, conf, "phrase" if phrase else "cite", u, labels(before[1]),
                    sub_of(before[1]), law_text=t[s:e])
            else:
                add(s, e, kind, "whole_law", form, dtype, keys, conf, "phrase" if phrase else "named" if (s, e, k) in named else "cite",
                    law_text=t[s:e])
        # 8 any mention of the principal enactment; "the Constitution"
        if self.principal:
            for m in refs.PRINC.finditer(t):
                add(m.start(), m.end(), "cites", "whole_law", "principal", "law", [self.principal], "high", "principal")
        for m in re.finditer(r"\bthe\s+Constitution\b(?!\s+of\s+the\s+(?!Democratic|Republic))", t):
            add(m.start(), m.end(), "cites", "whole_law", "constitution", "constitution", ["constitution"], "high", "constitution")
        # 9 a bare section / Article: this law's own, or in an amending law the law it amends; an Article in the
        # Constitution's own documents is the Constitution's; gazettes and other laws' Articles (treaties) are left out
        if not self.key.startswith("gazette:"):
            for m in BARE.finditer(t):
                art = m["parts"].lower().startswith("art")
                if art and not self.family:
                    continue
                if FOLLOW.match(t, m.end()):
                    continue
                if re.match(r"\s*\.", t[m.end():m.end() + 2]) and re.search(r"(?:^|[.:]\s|\n)\s*$", t[max(0, m.start() - 3):m.start()]):
                    continue                                # "Section 12. Dividends": the section's own heading
                if art:
                    dst, form, dtype = ("constitution", "constitution", "constitution")
                elif self.amending and self.principal:
                    dst, form, dtype = self.principal, "principal", "law"
                else:
                    dst, form, dtype = self.key, "this_law", "self"
                u = unit_of(m["parts"])
                add(m.start(), m.end(), "cites", "provision", form, dtype, [dst], "low" if form == "principal" else "medium",
                    "bare", u, labels(m["parts"]), sub_of(m["parts"]))
        self.last += [(kw, k) for _, kw, k in seen if k]
        return self.one_per_span(out)

    def chunk_principal(self, t):
        for m in graph.PRINCIPAL.finditer(t):
            w = t[max(0, m.start() - 300):m.start()]
            if (am := list(refs.AMENDED_BY.finditer(w))) and refs.AMENDERS.fullmatch(w[am[-1].end():]):
                w = w[:am[-1].start()]
            law = list(re.finditer(refs.LAW, w))
            if law and (keys := self.law(law[-1][0])):
                self.principal = keys[-1]

    @staticmethod
    def in_quote(t, pos):
        """Inside quoted text: more opening than closing curly quotes before pos, or an odd number of straight ones."""
        return t.count("“", 0, pos) > t.count("”", 0, pos) or (t.count('"', 0, pos) % 2 == 1)

    def one_per_span(self, out):
        """Overlapping mentions of one law keep the most specific; a citation of another law inside a change clause
        ("as amended by Act No. 39 of 1983") stays. Exact duplicates go."""
        out.sort(key=lambda r: (PRIORITY.get(r["via"], 4), r["start"], -(r["end"] - r["start"])))
        kept = []
        for r in out:
            dup = False
            for k in kept:
                if r["start"] < k["end"] and k["start"] < r["end"] and (r["dst_doc"] == k["dst_doc"] or r["dst_doc"] is None) \
                        and (not r["labels"] or set(r["labels"]) <= set(k["labels"])):
                    dup = True
                    break
            if not dup:
                kept.append(r)
        return sorted(kept, key=lambda r: r["start"])

    def title_mentions(self):
        """The long title's change of a whole law (refs.Doc.long_title_links), as mentions with no chunk."""
        out = []
        for _, kind, k, _, ctx, _ in self.long_title_links():
            rel, scope = ("repeals", "whole_law") if kind == "repeals_act" else ("amends", "whole_law")
            out.append(dict(i=None, start=0, end=min(len(self.lt), 300), span=re.sub(r"\s+", " ", self.lt[:300]).strip(),
                            relation=rel, scope=scope, law_form="number" if re.search(r"/\d{4}$", k) else "name",
                            law_text=None, dst_type="constitution" if k == "constitution" else "law", dst_doc=k, dst_name=None,
                            unit=None, labels=[], sub=None, confidence="high" if re.search(r"/\d{4}$", k) else "medium",
                            via="long_title", ops=None, in_quote=False, context=ctx))
        return out


def mentions(key, long_title, texts, held=None):
    """A law's chunks (texts, in order) -> mention dicts (docs/LINKS.md); `i` is the chunk index (None: long title).
    A mention naming the law itself is kept only as a same-law reference (dst_type self) with labels."""
    d = Doc(key, long_title, texts, held)
    out = d.title_mentions()
    for i, t in enumerate(texts):
        out += d.mentions(i, t)
    keep = []
    for r in out:
        if r["dst_doc"] == key and r["dst_type"] != "self":
            if not r["labels"]:
                continue
            r = dict(r, dst_type="self", law_form="this_law" if r["law_form"] == "name" else r["law_form"])
        if r["dst_doc"] == "constitution" and key.startswith("constitution") and r["dst_type"] == "constitution":
            if not r["labels"]:
                continue
            r = dict(r, dst_doc=key, dst_type="self")
        keep.append(r)
    return keep


def kind_of(r):
    """The legacy `kind` (kb.links.kind): relation, plus _act for a whole law."""
    if r["relation"] in ("amends", "repeals") and r["scope"] == "whole_law" and r["dst_type"] != "gazette":
        return r["relation"] + "_act"
    return r["relation"]


if __name__ == "__main__":
    for r in mentions("act:1/2099", "", [sys.argv[1]]):
        print({k: v for k, v in r.items() if v not in (None, [], False) and k != "context"})
