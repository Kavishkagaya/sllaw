"""python3 -m etl.v2.show <key> [pages] -- a document's blocks (role, box, text) and v2 paragraphs, for review."""
import os, sys
from etl.v2 import blocks as b3, gate
from etl.v2.profiles import profile

key, npages = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 2
gate._init()
row = next(r for r in gate.rows({key}, None))
_, title, sha, raw_key, meta = row
raw = gate._get(raw_key)
try:
    lo = gate._get(f"raw/lighton/{sha}.json.gz")
except Exception:
    lo = None
prof = profile(key, title)
bs, engine = b3.read(raw, lo, le1980=bool(meta.get("cap")), spread=bool(meta.get("spread")), gazette=bool(prof.get("gazette")))
print(key, engine, title)
for b in bs:
    if b["page"] <= npages:
        print(f"  p{b['page']} {b['role'][:4]:4} {[round(x) for x in b['bbox']]} {b['text'][:70]!r}")
prof = profile(key, title)
paras, st = b3.paragraphs(bs, engine, gazette=bool(prof.get("gazette")))
print("-- v2 paragraphs (first 25):")
for p in paras[:25]:
    print(f"  p{p.get('page')} {p['text'][:90]!r}" + (f"  NOTE {p['note'][:40]!r}" if p["note"] else ""))
