"""A document's dates, as v1 had them (etl/structure.py: build_one, commencement), read from its chunks.

  certified   the listing's date; a year-only listing (lankalaw) takes the date the law prints
              ("[Certified on 15th July, 2023]", "[ 17th December , 1988 ]") when it is in the key's year; a 1980
              Revised Edition chapter takes the printed date under its long title (its first enactment).
  commenced   when the whole law came into force: section 1, or a section whose note says operation / commencement /
              retrospective, "this Act shall come into operation on ..."; else the certified date. The app dates a
              law's change links by it (as at a date, docs/APP.md).
"""
import re

from etl.structure import CERTIFIED, parse_date

BRACKET = re.compile(r"\[\s*(\d{1,2}\s*(?:st|nd|rd|th)?\s+[A-Za-z]+\s*[,.]?\s*\d{4})\s*\.?\s*[\]}]")
COMES = re.compile(r"(?:this Act|provisions of this Act(?:,? other than this section)?)(?:[^.;:]|\bNo\.){0,120}?"
                   r"shall\s+(be\s+deemed\s+to\s+have\s+)?come\s+into\s+(?:operation|force)\s+"
                   r"(?:on|from|with\s+effect\s+from)\s+([^.;:]{0,140})", re.I)
NOTE = re.compile(r"operation|commence|retrospect", re.I)


def bracket_date(m):
    """"[ 3 rd September , 1985 ]" -> 1985-09-03 (v1: the "rd" joined, the space before the comma dropped)."""
    return parse_date(re.sub(r"\s+,", ",", re.sub(r"(\d)\s+(st|nd|rd|th)\b", r"\1\2", m[1])))


def printed_date(chunks):
    """The date printed in the front matter: before the first section's text (a 1980 chapter's heading, long title
    and date sit at the top of its section 1 chunk), or None."""
    for c in chunks[:12]:
        for line in c["text"].splitlines():
            if c.get("kind") == "unit" and re.match(r"\s*1\.\s", line):
                return None
            if (m := CERTIFIED.search(line)) and (d := parse_date(m[1])):
                return d
            if (m := BRACKET.search(line)) and (d := bracket_date(m)):
                return d
        if c.get("kind") == "unit":
            return None
    return None


def sections(chunks):
    """[(crumb, text)] per section: a unit chunk and its "(cont.)" chunks joined."""
    out = []
    for c in chunks:
        if c.get("kind") != "unit":
            continue
        crumb = c.get("crumb") or ""
        if out and crumb.endswith(" (cont.)") and crumb[:-8] == out[-1][0]:
            out[-1] = (out[-1][0], out[-1][1] + " " + c["text"])
        else:
            out.append((crumb, c["text"]))
    return out


def commencement(chunks, certified):
    """-> (date, {kind, text}); kind: date | deemed | appointed | certified | unstated (etl/structure.py)."""
    secs = sections(chunks)
    note = lambda crumb: crumb.rsplit(" › ", 1)[-1]
    for crumb, text in secs[:1] + [s for s in secs[1:] if NOTE.search(note(s[0]))]:
        m = COMES.search(text)
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


def printed_in_paras(paras):
    """v1's way: the first "Certified on" or bracketed date among the first paragraphs (the cover and front matter,
    which the chunks leave out)."""
    for p in paras[:80]:
        t = p["text"].strip()
        if (m := CERTIFIED.search(t)) and (d := parse_date(m[1])):
            return d
        if (m := BRACKET.fullmatch(t.rstrip("."))) and (d := bracket_date(m)):
            return d
    return None


def dates(key, chunks, listed=None, precision=None, paras=None):
    """-> {certified, commenced, commencement} (ISO dates or None). paras: the build's paragraphs (preferred)."""
    year = m[1] if (m := re.search(r"/(\d{4})$", key)) else None
    # v1: the listing's date (a year-only listing as 1 January), the printed one for a year-only listing in the key's year
    certified = listed[:10] if listed and re.match(r"\d{4}-\d\d-\d\d", listed) else None
    printed = (printed_in_paras(paras) if paras else None) or printed_date(chunks)
    if key.startswith("cap:"):
        certified = printed
    elif printed and (not year or printed[:4] == year) and (precision == "year" or not certified):
        certified = printed
    commenced, how = commencement(chunks, certified)
    return {"certified": certified, "commenced": commenced, "commencement": how}
