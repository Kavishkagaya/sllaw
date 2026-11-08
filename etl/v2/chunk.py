"""Stage 5: a document's tree -> chunks (docs/PIPELINE_V2.md).

One container (unit, schedule, block, front) is one chunk, cut into pieces over MAX chars at paragraph ends; a
paragraph over MAX is split first (etl.docs.split_long), a table by rows with its header row repeated. The notes
of a container's paragraphs go at the end of its first piece as italic tails, as etl.docs.chunks() writes them, so
a chunk whose text did not change keeps its text_hash and embed copies its vector.

Identity (decided 2026-11-07): address = document key / scope / label [#n] / piece, the breadcrumb and unique
key in one; id = uuid5(NAMESPACE, address); text_hash = sha1 of the text.
"""
import hashlib, re, uuid

from etl.docs import MAX, split_long
from etl.v2.tree import units

NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/Kavishkagaya/sllaw")
WHOLE_NOTE = re.compile(r"\b(?:by|of|to|the|and|or|in|for|under|with|a|an|on|from)$", re.I)


def split_table(text, rows):
    """A table over MAX -> pieces of whole rows, each starting with the header row."""
    lines = [" | ".join(c for c in r if c) for r in rows]
    if len(text) <= MAX or len(lines) < 3:
        return split_long(text)
    head, out, piece = lines[0], [], []
    for ln in lines[1:]:
        if piece and len(head) + sum(len(x) + 1 for x in piece) + len(ln) > MAX:
            out.append("\n".join([head] + piece))
            piece = []
        piece.append(ln)
    if piece:
        out.append("\n".join([head] + piece))
    return [p for x in out for p in split_long(x)]       # a single row over MAX still gets cut


def pieces(container):
    """A container's paragraphs -> [text, ...], cut at paragraph ends over MAX (etl.docs.chunks close())."""
    out, piece, n = [], [], 0
    for c in container["children"]:
        for t in (split_table(c["text"], c["rows"]) if c.get("rows") else split_long(c["text"])):
            if piece and n + len(t) > MAX:
                out.append("\n\n".join(piece))
                piece, n = [], 0
            piece.append(t)
            n += len(t)
    if piece:
        out.append("\n\n".join(piece))
    notes = [c["note"] for c in container["children"] if c.get("note")]
    if notes and out:
        out[0] = out[0] + " " + " ".join(f"*{x}*" for x in notes)
    return [t for t in out if t.strip()]


def note_of(container):
    n = (next((c.get("note") for c in container["children"] if c.get("note")), None) or "").strip("* ")
    whole = n and len(n) <= 100 and n[0].isupper() and not WHOLE_NOTE.search(n.rstrip(" .,;"))
    return n if whole else None


def chunks(key, tree, prof):
    """-> [{address, id, text_hash, label, kind, crumb, text}] in reading order."""
    out, seen, blocks = [], {}, {}
    for scope, c in units(tree):
        if c["kind"] in ("unit", "schedule"):
            name = c["label"]
        elif c["kind"] == "front":
            name = "front"
        else:
            blocks[scope and scope["label"]] = blocks.get(scope and scope["label"], 0) + 1
            name = f"block{blocks[scope and scope['label']]}"
        where = [key] + ([scope["label"]] if scope else [])
        k = "/".join(where + [name])
        seen[k] = seen.get(k, 0) + 1
        if seen[k] > 1:
            name = f"{name}#{seen[k]}"
        crumb_unit = (f"{prof['unit']} {c['label']}" + (f" — {note}" if (note := note_of(c)) else "")
                      if c["kind"] == "unit" else c["label"] if c["kind"] == "schedule" else None)
        crumb_scope = (scope["label"] + (f" — {scope['title']}" if scope.get("title") else "")) if scope else None
        crumb = " › ".join(x for x in (crumb_scope, crumb_unit) if x) or None
        for i, t in enumerate(pieces(c), 1):
            address = "/".join(where + [name, str(i)])
            out.append({"address": address, "id": str(uuid.uuid5(NAMESPACE, address)),
                        "text_hash": hashlib.sha1(t.encode()).hexdigest(),
                        "label": c["label"] if i == 1 and c["kind"] in ("unit", "schedule") else None,
                        "kind": c["kind"], "crumb": crumb + (" (cont.)" if i > 1 else "") if crumb else None,
                        "text": t})
    return out
