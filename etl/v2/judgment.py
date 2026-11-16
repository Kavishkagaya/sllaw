"""Stages 4-5 for court judgments (court-judgments brief, #63): a judgment is prose, not numbered provisions, so it
has its own short path instead of the law tree (profiles.py, tree.py).

  chunk 1    "case details", from the court's listing: case number, decided date, judge, parties, keywords and the
             Legislation column. The links stage reads it like any chunk text, so the Legislation column becomes
             links the same way a judgment's own citations do; search sees the keywords and the parties.
  caption    the judgment's own heading: everything up to its last "Before:" / "Counsel:" / "Argued on" / "Decided on"
             line in the first pages, and the short lines right after it (the judge's name, "JUDGMENT"). Found in
             79 of 80 sampled judgments (2026-11-16); bench and counsel become their own chunks ("caption"), and the
             opinion's chunks no longer carry party addresses and counsel lists. No such line: no caption.
  opinion    the rest in reading order (stage 3 blocks, any engine), packed up to MAX chars and cut at paragraph ends
             (a paragraph over MAX is split, etl.docs.split_long); each chunk's breadcrumb is its page or pages
             ("page 3", "pages 3-4") and, when the judgment numbers its paragraphs (about half do: 41 of 80
             sampled), the numbers opening in it ("page 3 · paras 12-14"), so a citation opens the PDF where the
             text is and "at paragraph 13" can be found.

Address = key/<n>/1 (a published PDF never changes, so the n-th chunk of a file stays the n-th). This module is not
in build.py's code hash (laws do not rebuild when it changes); its own hash is part of the judgment profile, so a
change here rebuilds judgments only.
"""
import hashlib, os, re, uuid

from etl.docs import MAX, split_long
from etl.v2 import blocks as b3
from etl.v2.chunk import NAMESPACE

CODE = hashlib.sha1(open(__file__, "rb").read()).hexdigest()[:16]
PREFIXES = ("ca:", "sc:")
COURT = {"ca": "Court of Appeal", "sc": "Supreme Court"}
CAPTION = re.compile(r"^\s*(before|coram|counsel|argued on|heard on|decided on|delivered on|written submissions?\b|"
                     r"judgment delivered|judgement delivered)", re.I)
CAPTION_TAIL = re.compile(r"^(J\s*U\s*D\s*G\s*E?\s*M\s*E\s*N\s*T|O\s*R\s*D\s*E\s*R)\s*:?$|\bJ\s*\.?$|\bP\s*/?\s*C\s*J\s*\.?$|\bC\s*J\s*\.?$", re.I)
NUMBERED = re.compile(r"^\(?(\d{1,3})[.)]\s+\S")
CAPTION_PAGES = 4                  # a caption longer than this is not a caption


def profile(key):
    return {"kind": "judgment", "court": key.split(":")[0], "unit": "paragraph", "headings": False, "notes": False,
            "code": CODE}


def details(key, row):
    """The listing row -> the case-details text (chunk 1)."""
    lines = [f"{COURT[key.split(':')[0]]}, {row.get('case')}, decided {row.get('date')}."]
    for name, field in (("Judgment by", "judge"), ("Parties", "parties"), ("Keywords", "keywords"),
                        ("Legislation", "legislation")):
        if (v := (row.get(field) or "").strip(" ,;")):
            lines.append(f"{name}: {v}")
    return "\n".join(lines)


def _chunk(key, n, text, pages, crumb=None):
    address = f"{key}/{n}/1"
    crumb = crumb or (f"page {pages[0]}" if pages[0] == pages[-1] else f"pages {pages[0]}-{pages[-1]}")
    return {"address": address, "id": str(uuid.uuid5(NAMESPACE, address)), "text_hash": hashlib.sha1(text.encode()).hexdigest(),
            "label": None, "kind": "block", "crumb": crumb, "text": text}


def _text(p):
    return " ".join(x for x in (p["text"], (p.get("note") or "").strip()) if x).strip()


def caption_end(paras):
    """-> how many leading paragraphs are the caption (0: none found)."""
    first = paras[0]["page"] if paras else 0
    marks = [i for i, p in enumerate(paras) if p["page"] - first < CAPTION_PAGES and CAPTION.match(_text(p))]
    if not marks:
        return 0
    end = marks[-1] + 1
    while end < len(paras) and len(_text(paras[end])) <= 80 and CAPTION_TAIL.search(_text(paras[end])):
        end += 1
    return end


def para_numbers(paras):
    """-> {index: number} for paragraphs that open with the judgment's own numbering: 1, 2, 3 ... in order (a list
    inside the text restarting at 1 is not the numbering); none unless at least 5 follow on."""
    got, last = {}, 0
    for i, p in enumerate(paras):
        if (m := NUMBERED.match(p["text"])) and int(m[1]) == last + 1:
            got[i], last = int(m[1]), int(m[1])
    return got if len(got) >= 5 else {}


def _pack(paras, number=None):
    """Paragraphs -> [(text, pages, paragraph numbers)], packed up to MAX at paragraph ends."""
    out, piece, pages, nums, n = [], [], [], [], 0
    for i, p in enumerate(paras):
        text = _text(p)
        for j, t in enumerate(split_long(text) if text else []):
            if piece and n + len(t) > MAX:
                out.append(("\n\n".join(piece), pages, nums))
                piece, pages, nums, n = [], [], [], 0
            piece.append(t)
            pages.append(p["page"])
            if j == 0 and number and i in number:
                nums.append(number[i])
            n += len(t)
    if piece:
        out.append(("\n\n".join(piece), pages, nums))
    return out


def _where(pages, nums):
    crumb = f"page {pages[0]}" if pages[0] == pages[-1] else f"pages {pages[0]}-{pages[-1]}"
    if nums:
        crumb += f" · para {nums[0]}" if len(nums) == 1 else f" · paras {nums[0]}-{nums[-1]}"
    return crumb


def chunks(key, row, paras):
    """-> chunks in reading order: case details, the caption, the opinion."""
    out = [_chunk(key, 1, details(key, row), [None], crumb="case details")]
    end = caption_end(paras)
    for i, (t, pages, _) in enumerate(_pack(paras[:end])):
        out.append(_chunk(key, len(out) + 1, t, pages, crumb="caption" + (" (cont.)" if i else "")))
    body = paras[end:]
    for t, pages, nums in _pack(body, para_numbers(body)):
        out.append(_chunk(key, len(out) + 1, t, pages, crumb=_where(pages, nums)))
    return out


def build_doc(key, row, raw, lo):
    """In memory: -> (prof, engine, paras, stats, tree, chunks, issues)."""
    prof = profile(key)
    # a born-digital judgment is read from docling's line cells, top to bottom (blocks.gazette_lines): docling's layout
    # boxes cut a wrapped line off and put it out of order ("...the said Respondent had never" / "been present before
    # this Court." two blocks apart, CA/WRT/0634/2023). A judgment has no marginal notes: the law reader's margin
    # column took 60 of that judgment's 146 blocks for notes, its "Before: ... Counsel:" block among them (2026-11-16)
    bs, engine = b3.read(raw, lo, gazette=True)
    bs = [{**b, "role": "body"} if b["role"] == "margin" else b for b in bs]
    paras, st = b3.paragraphs(bs, engine, gazette=True)
    ch = chunks(key, row, paras)
    text = sum(len(c["text"]) for c in ch[1:])
    issues = [{"check": "no_text", "severity": "error", "where": key, "page": None,
               "evidence": f"{len(paras)} paragraphs", "cause": "no text read from the file"}] if text < 200 else []
    tree = {"kind": "judgment", "listing": row, "paragraphs": [{"page": p["page"], "text": p["text"]} for p in paras]}
    return prof, engine, paras, st, tree, ch, issues
