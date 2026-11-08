"""Checks on one built document -> issues (docs/PIPELINE_V2.md, stage 4 checks). The builder's own feedback: every
issue says what, where (address or page), the text that shows it, and its likely cause, so a fix can be aimed at
the cause and a rerun shows which issues went away.

  issue = {check, severity, where, page, evidence, cause}
  severity  error  text or a unit lost   warn  likely ours (fixable)   info  source, OCR, or a second opinion agrees
            accepted  reviewed and accepted in etl/overrides.json (the gate, etl.v2.gate)
"""
import re

from etl.structure import AMEND, INTRO, QUOTES
from etl.v2 import tree as t4

TAIL = re.compile(r"[.;:)\]—–\-|”’\"'*]\s*$")
SCRIPT = re.compile(r"[඀-෿஀-௿]")


def gaps(labels):
    nums = {int(m[1]) for x in labels if (m := re.fullmatch(r"(\d+)[A-Z]*", x))}
    return [i for i in range(1, max(nums, default=0) + 1) if i not in nums]


def gap_cause(n, paras):
    """Why section n is missing: the text itself says."""
    starts = re.compile(rf"^\s*{n}\s*[.,]\s")
    inside = re.compile(rf"(?<![\d(.])\b{n}\s*\.\s+[A-Z(“\"]")
    for p in paras:
        if starts.match(p["text"]):
            return "rejected", p
    for p in paras:
        if inside.search(p["text"][3:]):
            return "inside", p
    for p in paras:
        if p.get("note") and re.search(rf"(?<![\d.]){n}(?![\d])", p["note"]):
            return "note_only", p
    return "absent", None


CAUSE = {"rejected": ("warn", "a paragraph opens with it but the sequence rule refused it"),
         "inside": ("warn", "it sits inside another paragraph: two blocks merged"),
         "note_only": ("warn", "the number is in the margin note, not in the body"),
         "absent": ("info", "not in the text: not printed (repealed?), the file starts late, or OCR lost it")}


def check(key, prof, paras, stats, tree, info, chunks, structure=None):
    out = []

    def add(check, severity, where=None, page=None, evidence=None, cause=None):
        out.append({"check": check, "severity": severity, "where": where, "page": page,
                    "evidence": (evidence or "")[:200] or None, "cause": cause})

    units = [(s, u) for s, u in t4.units(tree) if u["kind"] == "unit"]
    labels = {u["label"] for _, u in units}
    for n in gaps(labels):
        kind, p = gap_cause(n, paras)
        add("gap", CAUSE[kind][0], f"{key} section {n}", p and p.get("page"), p and p["text"], f"{kind}: {CAUSE[kind][1]}")
    # quoted text read as a unit: an amending formula ("... the following section substituted therefor:-") just
    # before it, or a note opening with a quote mark (an inserted section's own note), and no amending formula itself
    prev = None
    for scope, u in t4.units(tree):
        if u["kind"] == "unit" and u["children"] and prev and prev["children"]:
            before, first = prev["children"][-1]["text"], u["children"][0]
            body = re.sub(r"^\d{1,3}[A-Z]{0,4}\s*\.\s*", "", first["text"])
            why = ("after an amending formula" if INTRO.search(before) else
                   "its note opens a quote it never closes" if prof.get("amending") and ((n := first.get("note") or " ")[0] in QUOTES
                                                                  and not any(ch in QUOTES for ch in n[1:])) else None)
            follows = (re.fullmatch(r"\d+", u["label"]) and re.fullmatch(r"\d+", prev.get("label") or "")
                       and int(u["label"]) == int(prev["label"]) + 1)          # the law's own next number: fine
            if why and not AMEND.match(body) and not follows:
                add("quoted_as_unit", "warn", f"{key} section {u['label']}", first.get("page"), first["text"],
                    f"{why}: likely the text an amendment inserts — before: {before[-80:]}")
        prev = u
    for r in info["rejected"]:
        add("rejected_opener", "info", key, r["page"], r["text"], f"{r['why']}: after {r['after']}")
    contents = info["contents"]
    if contents:
        for n in sorted(set(contents) - labels, key=lambda x: (len(x), x)):
            add("contents_missing", "warn", f"{key} section {n}", None, contents[n],
                "listed in the printed contents, not found in the body")
        for n in sorted(labels - set(contents), key=lambda x: (len(x), x)):
            add("contents_extra", "info", f"{key} section {n}", None, None, "found in the body, not in the printed contents")
    if prof["notes"] and sum(u.get("note_on_opener", False) for _, u in units) >= 0.5 * max(1, len(units)):
        for _, u in units:
            if not u.get("note_on_opener"):
                first = u["children"][0] if u["children"] else {}
                add("no_note", "info", f"{key} section {u['label']}", first.get("page"), first.get("text"),
                    "notes are printed in this law; this unit has none")
    for a, b in zip(chunks, chunks[1:]):
        if b["address"].rsplit("/", 1)[0] == a["address"].rsplit("/", 1)[0] and not TAIL.search(a["text"]):
            add("mid_sentence", "info", a["address"], None, a["text"][-120:], "a piece ends inside a sentence")
    if stats.get("margin_as_body"):
        add("margin_as_body", "info", key, None, None,
            f"kept as body: {stats['margin_as_body']} margin blocks, {stats['margin_as_body_words']} words")
    if info["headings_not_scope"]:
        add("heading_not_scope", "info", key, None, None, f"out of sequence: {info['headings_not_scope']} headings")
    # a second opinion: the old section assembler (acts.doc), which tracks quotes, while it exists
    if structure is not None:
        old = set(structure)
        for n in sorted(labels - old, key=lambda x: (len(x), x)):
            add("not_in_structure", "info", f"{key} section {n}", None, None, "a v2 unit the old assembler does not have")
        for n in sorted(old - labels, key=lambda x: (len(x), x)):
            add("structure_has", "info", f"{key} section {n}", None, None, "the old assembler has it, v2 does not")
    other = sum(len(SCRIPT.findall(p["text"])) for p in paras)
    if other > 200:
        add("other_script", "warn", key, None, None, f"other script: {other} Sinhala/Tamil characters in an English document")
    return out
