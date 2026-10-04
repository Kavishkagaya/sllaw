"""Full validation. Independent checks only (not the continuity the parser enforces):
  - note/body citation cross-check  (note says 'section N', body must cite N)
  - truncation check (last section should be the Sinhala-text clause if present)
  - marginal-note coverage
"""
import glob, os, re, json, importlib.util
import pypdfium2 as pdfium

spec = importlib.util.spec_from_file_location("b12", "bind12.py")
b12 = importlib.util.module_from_spec(spec); spec.loader.exec_module(b12)
TAIL = re.compile(r'inconsistency between the Sinhala and Tamil', re.I)

tot = dict(secs=0, notes=0, mism=0, trunc=0, files=0)
print(f"{'file':7s} {'pg':>4} {'secs':>5} {'notes':>6} {'mismatch':>9} {'tail':>6}")
for p in sorted(glob.glob("corpus/*.pdf")):
    name = os.path.basename(p)[:-4]
    doc = pdfium.PdfDocument(p)
    raw = "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    if len(raw.strip()) < 200: continue
    secs = b12.extract(p)
    if not secs: print(f"{name:7s} {len(doc):>4}  NO SECTIONS"); continue
    notes = sum(1 for s in secs if s["marginal_note"])
    mism = 0
    for s in secs:
        n = s["marginal_note"] or ""; b = s["body"][0]
        mn = re.search(r'section (\d+[A-Z]*)', n, re.I); mb = re.search(r'[Ss]ections? (\d+[A-Z]*)', b)
        if mn and mb and mn.group(1) != mb.group(1): mism += 1
    doc_tail = bool(TAIL.search(raw))
    got_tail = bool(TAIL.search(" ".join(secs[-1]["body"])))
    tail = "ok" if (got_tail or not doc_tail) else "TRUNC"
    tot["files"] += 1; tot["secs"] += len(secs); tot["notes"] += notes
    tot["mism"] += mism; tot["trunc"] += (tail == "TRUNC")
    print(f"{name:7s} {len(doc):>4} {len(secs):>5} {notes:>4}/{len(secs):<3} {mism:>9} {tail:>6}")
    json.dump(secs, open(f"sweep_out/{name}.json","w"), indent=1)
    md=[]
    for s in secs:
        md.append(f"### Section {s['number']}")
        if s["marginal_note"]: md.append(f"> **{s['marginal_note'].rstrip('.')}**")
        md.append("\n\n".join(s["body"]))
    open(f"sweep_out/{name}.md","w").write("\n\n".join(md))

print(f"\n{tot['files']} files | {tot['secs']} sections | "
      f"notes {tot['notes']}/{tot['secs']} ({100*tot['notes']/tot['secs']:.1f}%) | "
      f"mismatches {tot['mism']} | truncated {tot['trunc']}")
