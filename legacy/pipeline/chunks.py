"""Sri Lankan statute PDF -> RAG chunks with breadcrumbs.

Chunk = one section (or one paragraph of a long section), carrying:
  breadcrumb   human-readable provenance, good for citation and for embedding
  act/no/year  parsed from the cover
  section      section number as printed
  note         marginal note (carries amendment references)
  pages        source pages

ponytail: no strict section-numbering guarantee - RAG doesn't need it. Text
correctness, provenance and note attachment are what matter.
"""
import sys, re, os, json, importlib.util
import pypdfium2 as pdfium

_s = importlib.util.spec_from_file_location("ed", os.path.join(os.path.dirname(__file__) or ".", "bind14.py"))
ed = importlib.util.module_from_spec(_s); _s.loader.exec_module(ed)

# title chars only - no digits/brackets, so it can't run back into cover junk
TITLE = re.compile(
    r"([A-Z][A-Za-z'()\u2019\-]*(?:[ ][A-Za-z'()\u2019\-]+){0,9}[ ]"
    r"(?:ACT|Act|ORDINANCE|Ordinance|LAW|Law))\s*,?\s*No\.?\s*(\d+)\s+of\s+(\d{4})")
MAX_CHARS = 1200          # split long sections; keep paragraphs whole


def act_meta(path):
    """Act identity from the RUNNING HEADER (repeats on every page, so it is far
    more reliable than the cover, which varies). Falls back to the cover."""
    import collections
    doc = pdfium.PdfDocument(path)
    votes = collections.Counter()
    for i in range(len(doc)):
        for ln in doc[i].get_textpage().get_text_range().split("\n")[:3]:
            ln = " ".join(ln.split()).strip()
            ln = re.sub(r'^\d{1,4}\s+|\s+\d{1,4}$', '', ln)   # strip page number
            m = TITLE.search(ln)
            if m:
                votes[(" ".join(m.group(1).split()), m.group(2), m.group(3))] += 1
    if votes:
        (a, n, y), _ = votes.most_common(1)[0]
        # a header line can carry a sentence prefix ("...may be cited as the X Act")
        a = re.sub(r"^.*?\b(?:cited as|known as|referred to as)\s+the\s+(?=[A-Z])", "", a)
        return {"act": a, "number": n, "year": y}
    head = re.sub(r'\s+', ' ', "\n".join(
        doc[i].get_textpage().get_text_range() for i in range(min(3, len(doc)))))
    m = TITLE.search(head)
    if m:
        a = re.sub(r"^.*?\b(?:cited as|known as|referred to as)\s+the\s+(?=[A-Z])", "", " ".join(m.group(1).split()))
        return {"act": a, "number": m.group(2), "year": m.group(3)}
    return {"act": os.path.basename(path)[:-4], "number": None, "year": None}


def chunks(path):
    meta = act_meta(path)
    label = f"{meta['act']}, No. {meta['number']} of {meta['year']}" if meta["number"] else meta["act"]
    out = []
    for s in ed.extract(path):
        note = (s["marginal_note"] or "").strip().rstrip(".")
        crumb = f"{label} › Section {s['number']}" + (f" › {note}" if note else "")
        # pack paragraphs into chunks under MAX_CHARS, never splitting a paragraph
        buf, parts = [], []
        for para in s["body"]:
            if buf and sum(len(x) for x in buf) + len(para) > MAX_CHARS:
                parts.append(" ".join(buf)); buf = []
            buf.append(para)
        if buf: parts.append(" ".join(buf))
        for i, text in enumerate(parts):
            out.append({
                "id": f"{os.path.basename(path)[:-4]}-s{s['number']}" + (f"-{i+1}" if len(parts) > 1 else ""),
                "breadcrumb": crumb,
                "act": label, "section": s["number"], "note": note or None,
                "page": s["page"], "part": i + 1, "of": len(parts),
                "text": text,
            })
    return out


if __name__ == "__main__":
    cs = chunks(sys.argv[1])
    if len(sys.argv) > 2: json.dump(cs, open(sys.argv[2], "w"), indent=1)
    print(f"{len(cs)} chunks\n")
    for c in cs[:4]:
        print(f"--- {c['id']}\n{c['breadcrumb']}\n{c['text'][:190]}\n")
