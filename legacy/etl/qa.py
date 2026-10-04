#!/usr/bin/env python3
"""Completeness gate. Nothing reaches the index until it passes.

RAG's worst failure is silently indexing 30% of a statute and looking healthy,
so every document is scored against its own source text and flagged rather than
trusted. Source-agnostic: it compares chunks to whatever raw text produced them,
which works the same for a PDF's text layer and an HTML body.
"""
import re

TAIL = re.compile(r'inconsistency between the Sinhala and Tamil', re.I)
norm = lambda s: re.sub(r'\W+', '', s).lower()


def report(chunks, raw, pages=None, skip_pages=()):
    """chunks: output of a parser. raw: the source text. pages: [str] per page
    for PDFs, which unlocks the page-span check. Returns a dict, ok=False if
    anything looks half-extracted."""
    flags = []
    if len(raw.strip()) < 200:
        return {"kind": "scanned", "ok": False, "chunks": 0, "flags": ["no_text_layer"]}
    if not chunks:
        return {"kind": "digital", "ok": False, "chunks": 0, "flags": ["no_chunks"]}

    secs = [c for c in chunks if c["kind"] == "section"]
    got = sum(len(norm(c["text"])) for c in chunks)

    # coverage over body pages only — the cover page and the back-matter price
    # notice belong to no chunk and would sink the ratio on short documents
    if pages:
        used = [p for c in chunks for p in c["pages"]]
        lo, hi = (min(used), max(used)) if used else (1, len(pages))
        tot = len(norm("".join(pages[lo - 1:hi])))
        body_end = max((i + 1 for i, t in enumerate(pages) if len(t.strip()) > 400),
                       default=len(pages))
        reach = hi / max(body_end, 1)
        if reach < 0.80:
            flags.append(f"stops_early:p{hi}/{body_end}")
        # a page missing from the middle is invisible to the reach check: it
        # still ends on the last page while silently dropping a section
        covered = set(used)
        # contents pages are deliberately skipped by the parser, so they are
        # not holes; anything else with real text on it is
        holes = [i + 1 for i, t in enumerate(pages[lo - 1:hi], start=lo - 1)
                 if len(t.strip()) > 400 and i + 1 not in covered
                 and i + 1 not in set(skip_pages)]
        if len(holes) > max(1, 0.05 * (hi - lo + 1)):
            flags.append(f"page_gaps:{len(holes)}@{holes[:3]}")
    else:
        tot, reach = len(norm(raw)), None

    cover = got / max(tot, 1)
    notes = sum(1 for c in chunks if c["note"])
    bleed = sum(1 for c in chunks if c["note"] and re.match(r'^[a-z]', c["note"]))
    ints = sorted({int(re.match(r'\d+', c["anchor"]).group())
                   for c in secs if c["anchor"] and re.match(r'\d+', c["anchor"])})
    gaps = [i for i in range(1, max(ints) + 1) if i not in ints] if ints else []
    tail_missing = bool(TAIL.search(raw)) and not any(TAIL.search(c["text"]) for c in chunks[-3:])

    # a document with text but no sections at all is the loudest possible
    # half-extraction signal — it means the layout pass gave up
    if not secs and len(raw) > 2000:
        flags.append("no_sections")
    if cover < 0.55:
        flags.append(f"low_text_coverage:{cover:.0%}")
    if tail_missing:
        flags.append("tail_clause_missing")
    if secs and notes / len(secs) < 0.60:
        flags.append(f"few_notes:{notes}/{len(secs)}")
    if bleed > max(3, 0.05 * len(chunks)):
        flags.append(f"note_bleed:{bleed}")
    # An act numbers its own sections 1..N; references to other acts' sections
    # never open a chunk. Measured: fixing one parser bug took three amendment
    # acts from 15/21/26 gaps to 0/0/3, so gaps are mostly lost sections, not
    # genuine discontinuity. The threshold still tolerates real ones — repealed
    # sections in consolidated statutes leave permanent holes.
    if ints and len(gaps) > max(3, 0.1 * max(ints)):
        flags.append(f"numbering_gaps:{len(gaps)}@{gaps[:3]}")
    if not any(c["kind"] == "preamble" for c in chunks) and pages:
        flags.append("no_preamble")

    return {"kind": "digital", "ok": not flags, "chunks": len(chunks),
            "sections": len(secs), "coverage": round(cover, 3),
            "page_reach": round(reach, 2) if reach else None,
            "notes": notes, "bleed": bleed, "gaps": len(gaps), "flags": flags}


def _selfcheck():
    C = lambda k, a, t, n="Note", p=(1,): {"kind": k, "anchor": a, "text": t, "note": n, "pages": list(p)}
    full = [C("preamble", None, "AN ACT " * 20), C("section", "1", "one " * 60),
            C("section", "2", "two " * 60)]
    raw = "".join(c["text"] for c in full)
    r = report(full, raw, pages=[raw])
    assert r["ok"], r
    half = report(full[:1], raw, pages=[raw])
    assert not half["ok"] and any(f.startswith("low_text_coverage") for f in half["flags"]), half
    assert report([], raw)["flags"] == ["no_chunks"]
    nosec = report([C("preamble", None, "x " * 2000)], "x " * 2000, pages=["x " * 2000])
    assert "no_sections" in nosec["flags"], nosec
    # a page dropped from the middle must be caught, not just a short tail
    body = ["y " * 300] * 6
    holed = report([C("section", "1", "t", p=(1,)), C("section", "9", "t", p=(6,))],
                   "".join(body), pages=body)
    assert any(f.startswith("page_gaps") for f in holed["flags"]), holed
    assert not any(f.startswith("page_gaps")
                   for f in report([C("section", "1", "t", p=(1,)), C("section", "9", "t", p=(6,))],
                                   "".join(body), pages=body,
                                   skip_pages=range(2, 6))["flags"]), "toc pages are not holes"
    # a document that loses a third of its sections must be flagged
    lost = report([C("section", str(n), "word " * 80) for n in (1, 2, 9, 14, 20)],
                  "word " * 400)
    assert any(f.startswith("numbering_gaps") for f in lost["flags"]), lost
    assert report(full, "   ")["kind"] == "scanned"
    print("selfcheck ok:", r["coverage"], half["flags"])


if __name__ == "__main__":
    _selfcheck()
