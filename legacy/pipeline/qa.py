"""Per-document quality report: is this extraction complete, or half-done?

RAG's worst failure is silently indexing 30% of a statute, so every document
gets scored and flagged rather than trusted.
"""
import re, importlib.util, pypdfium2 as pdfium

_s = importlib.util.spec_from_file_location("ed", "extract_digital.py")
ed = importlib.util.module_from_spec(_s); _s.loader.exec_module(ed)
TAIL = re.compile(r'inconsistency between the Sinhala and Tamil', re.I)


def norm(s):
    return re.sub(r'\W+', '', s).lower()


def report(path):
    doc = pdfium.PdfDocument(path)
    npages = len(doc)
    raw_pages = [doc[i].get_textpage().get_text_range() for i in range(npages)]
    raw = "\n".join(raw_pages)
    if len(raw.strip()) < 200:
        return {"file": path, "kind": "scanned", "ok": False, "flags": ["no_text_layer"]}

    secs = ed.extract(path)
    flags = []
    if not secs:
        return {"file": path, "kind": "digital", "ok": False, "sections": 0,
                "flags": ["no_sections"]}

    # 1. text coverage, measured over BODY pages only.
    # Cover page and back matter (subscription/price notice) belong to no
    # section and would sink the ratio on short acts.
    first_pg, last_pg_s = min(s["page"] for s in secs), max(s["page"] for s in secs)
    body_txt = "".join(raw_pages[first_pg-1:last_pg_s])
    got = sum(len(norm(" ".join(s["body"]))) for s in secs)
    tot = len(norm(body_txt))
    cover = got / max(tot, 1)

    # 2. page span: do sections reach the end of the document?
    last_pg = last_pg_s
    # ignore trailing back-matter pages (subscription page etc.)
    body_end = max((i+1 for i, t in enumerate(raw_pages)
                    if len(t.strip()) > 400), default=npages)
    page_reach = last_pg / max(body_end, 1)

    # 3. tail clause present in the document but not in our last section?
    tail_missing = bool(TAIL.search(raw)) and not TAIL.search(" ".join(secs[-1]["body"]))

    # 4. notes + bleed
    notes = sum(1 for s in secs if s["marginal_note"])
    bleed = sum(1 for s in secs if s["marginal_note"] and re.match(r'^[a-z]', s["marginal_note"]))

    # 5. numbering gaps
    ints = [int(re.match(r'\d+', s["number"]).group()) for s in secs]
    gaps = [i for i in range(1, max(ints)+1) if i not in ints]

    if cover < 0.55: flags.append(f"low_text_coverage:{cover:.0%}")
    if page_reach < 0.80: flags.append(f"stops_early:p{last_pg}/{body_end}")
    if tail_missing: flags.append("tail_clause_missing")
    if notes / len(secs) < 0.60: flags.append(f"few_notes:{notes}/{len(secs)}")
    if bleed: flags.append(f"note_bleed:{bleed}")
    if len(gaps) > max(2, 0.1*len(secs)): flags.append(f"numbering_gaps:{len(gaps)}")

    return {"file": path, "kind": "digital", "ok": not flags, "sections": len(secs),
            "coverage": round(cover, 3), "page_reach": round(page_reach, 2),
            "notes": notes, "bleed": bleed, "gaps": len(gaps), "flags": flags}


if __name__ == "__main__":
    import sys, glob, os
    rows = [report(p) for p in sorted(glob.glob(sys.argv[1] + "/*.pdf"))]
    print(f"{'file':22s} {'secs':>5} {'cover':>6} {'reach':>6} {'notes':>7}  flags")
    for r in rows:
        if r["kind"] == "scanned":
            print(f"{os.path.basename(r['file'])[:22]:22s} {'-':>5} {'-':>6} {'-':>6} {'-':>7}  SCANNED"); continue
        print(f"{os.path.basename(r['file'])[:22]:22s} {r.get('sections',0):>5} "
              f"{r.get('coverage',0):>6.0%} {r.get('page_reach',0):>6.2f} "
              f"{r.get('notes',0):>3}/{r.get('sections',0):<3}  {','.join(r['flags']) or 'OK'}")
    d = [r for r in rows if r["kind"] == "digital"]
    print(f"\n{len(d)} digital | clean {sum(1 for r in d if r['ok'])} | flagged {sum(1 for r in d if not r['ok'])}")
