"""A gazette's mentions, read the way a regulation is worded (gazette-links #81, docs/LINKS.md 2026-11-17).

etl/mentions.py reads every document with rules written for Acts; on gazettes they misfire: any "under section N"
was made_under, the "as amended by No. X, No. Y" chain was what a gazette amends, "the Notification published under
section 10 ... is repealed" repealed section 10. This runs after mentions(), on gazettes only, so a change here
relinks gazettes and nothing else (run.plan_links puts this file's hash in their fingerprint)."""
import re

from etl import refs

CHANGES = {"amends", "inserts", "replaces", "repeals", "rescinds"}
STOP = r"(?<!No)(?<!Nos)(?<!Gaz)(?<!Ex)(?<!Ord)(?<!Sec)(?<!Cap)[.;]\s"
# the power used: "by virtue of the powers vested in me", "in exercise of", "Regulations made by the Minister ...",
# "Order under", "approved by me in terms of"
POWER = re.compile(r"\b(?:powers?|authority)\b[^.;]{0,80}$|\b(?:by\s+virtue|in\s+(?:the\s+)?exercise|in\s+pursuance)\b[^.;]{0,160}$"
                   r"|\bmade\b[^.;]{0,160}$|\bapproved\b[^.;]{0,40}$"
                   r"|\b(?:orders?|regulations?|rules|by-?laws?|notifications?|notice|declaration|resolution|directions?)"
                   r"\s*(?:No\.?\s*:?\s*[\w/.-]+\s*(?:of\s+\d{4}\s*)?)?$", re.I)
CHAIN = re.compile(r"\bamended\s+by\b", re.I)
# a gazette's own change to another: "amend the Gazette ...", "rescind the orders published in", "by repeal of",
# "inserted into the Schedule of"; or after it, "... is hereby (further) amended | rescinded"
OP_BEFORE = re.compile(r"\b(amend|rescind|revoke|cancel|suspend|repeal|substitution|insert(?:ed)?\s+(?:in)?to)\b", re.I)
OP_AFTER = re.compile(r"\b(?:is|are|be|stands?)\s+(?:hereby\s+)?(?:further\s+)?(amended|rescinded|revoked|repealed|cancelled|"
                      r"suspended|replaced|varied)\b", re.I)
BARE_CHAPTER = re.compile(r"\W*(?:Chapter|Cap)\.?\s*\d+\W*$", re.I)
LAW_WORD = re.compile(r"\b(?:Ordinance|Act|Law|Code|Proclamation|Statute)\b", re.I)


def sentence(t, s, e, after=300):
    """The text of the sentence before a span and after it."""
    return re.split(STOP, t[max(0, s - 300):s])[-1], re.split(STOP, t[e:e + after])[0]


def rule(r, t):
    """One mention of a gazette -> the mention as the gazette means it, or None for no link."""
    if r["i"] is None or not t:
        return r
    before, after = sentence(t, r["start"], r["end"])
    if r["dst_type"] == "gazette":
        if r["relation"] not in ("amends", "rescinds"):
            return r
        if (m := list(CHAIN.finditer(before))) and not OP_BEFORE.search(before[m[-1].end():]):
            return {**r, "relation": "cites", "ops": None}           # an item of the "as amended by" chain
        b = list(OP_BEFORE.finditer(before))        # "rescind the orders published in", "by repeal of items ... of"
        a = OP_AFTER.search(after)                  # "... is hereby rescinded | repealed" (all of it), "... amended"
        if not b and not a:
            return {**r, "relation": "cites", "ops": None}           # "shall be deemed to be in effect"
        # the nearer verb is this gazette's: "amend Notification No. 902 ... and No. 974 in 1901/19 is hereby rescinded"
        if b and (not a or len(before) - b[-1].end() < a.start()):
            return {**r, "relation": "rescinds" if re.match(r"rescind|revoke|cancel", b[-1][1], re.I) else "amends"}
        return {**r, "relation": "amends" if re.match(r"amended|varied|suspended", a[1], re.I) else "rescinds"}
    if BARE_CHAPTER.match(r["span"] or "") and not LAW_WORD.search(before[-60:] + " " + after[:40]):
        return None                                                  # a customs tariff chapter: "Musical instruments (Chapter 92)"
    if r["law_form"] == "chapter" and r["law_text"] and (k := refs.by_name(r["law_text"])) and k != r["dst_doc"]:
        r = {**r, "dst_doc": k}       # the name printed beats the number: "Urban Councils Ordinance (Chapter 255)"
    if r["relation"] in CHANGES or r["relation"] == "made_under":   # a gazette changes no law (none found, 2026-11-17)
        return {**r, "relation": "made_under" if POWER.search(before) else "cites", "ops": None}
    return r


def apply(key, rows, texts):
    """mentions() rows of a document -> those rows read as a gazette (other documents unchanged)."""
    if not key.startswith("gazette:"):
        return rows
    out = (rule(r, texts[r["i"]] if r["i"] is not None else "") for r in rows)
    return [r for r in out if r is not None]
