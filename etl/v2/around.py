"""python3 -m etl.v2.around key:regex[,key:regex...] -- the paragraphs before the first paragraph matching regex
(a unit number "5", a heading "SCHEDULE"), as the tree saw them, with the document's title."""
import re, sys
from etl.v2 import gate

gate._init()
for spec in sys.argv[1].split(","):
    key, pat = spec.split(":", 2)[0] + ":" + spec.split(":", 2)[1], spec.split(":", 2)[2]
    row = next(r for r in gate.rows({key}, None))
    prof, engine, paras, st, tree, info, ch = gate.build(row)
    rx = re.compile(rf"\s*{re.escape(pat)}\s*\.\s" if re.fullmatch(r"\d+[A-Z]*", pat) else rf"\s*{pat}", re.I)
    i = next((i for i, p in enumerate(paras) if rx.match(p["text"])), None)
    print(f"## {key} [{pat}] ({engine}) {row[1][:70]}")
    for p in paras[max(0, (i or 0) - 2):(i or 0) + 1]:
        print("   |", p["text"][:170].replace("\n", " "), f"  NOTE={p['note'][:50]!r}" if p.get("note") else "")
