"""Held-out validation on PDFs never used during development."""
import glob, os, re, json, importlib.util, sys
import pypdfium2 as pdfium

_s = importlib.util.spec_from_file_location("b14", "bind14.py")
b14 = importlib.util.module_from_spec(_s); _s.loader.exec_module(b14)
TAIL = re.compile(r'inconsistency between the Sinhala and Tamil', re.I)

d = sys.argv[1] if len(sys.argv) > 1 else "corpus2"
rows, scans = [], 0
print(f"{'file':7s} {'pg':>4} {'secs':>5} {'notes':>8} {'bleed':>6} {'tail':>6}")
for p in sorted(glob.glob(f"{d}/*.pdf")):
    name = os.path.basename(p)[:-4]
    try:
        doc = pdfium.PdfDocument(p)
        raw = "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    except Exception as e:
        print(f"{name:7s} UNREADABLE {e}"); continue
    if len(raw.strip()) < 200:
        scans += 1; continue
    try:
        secs = b14.extract(p)
    except Exception as e:
        print(f"{name:7s} ERROR {type(e).__name__}: {e}"); rows.append((name, 0,0,0,"ERR")); continue
    if not secs:
        print(f"{name:7s} {len(doc):>4}   NO SECTIONS"); rows.append((name,0,0,0,"NONE")); continue
    notes = sum(1 for s in secs if s["marginal_note"])
    bleed = sum(1 for s in secs if s["marginal_note"] and re.match(r'^[a-z]', s["marginal_note"]))
    got = bool(TAIL.search(" ".join(secs[-1]["body"])))
    tail = "ok" if (got or not TAIL.search(raw)) else "TRUNC"
    rows.append((name, len(secs), notes, bleed, tail))
    print(f"{name:7s} {len(doc):>4} {len(secs):>5} {notes:>4}/{len(secs):<3} {bleed:>6} {tail:>6}")

S=sum(r[1] for r in rows); N=sum(r[2] for r in rows); B=sum(r[3] for r in rows)
T=sum(1 for r in rows if r[4]=="TRUNC"); E=sum(1 for r in rows if r[4] in ("ERR","NONE"))
print(f"\n{len(rows)} digital ({scans} scanned, skipped) | {S} sections")
print(f"notes {N}/{S} ({100*N/max(S,1):.1f}%) | bleed {B} ({100*B/max(N,1):.1f}%) | truncated {T} | failed {E}")
