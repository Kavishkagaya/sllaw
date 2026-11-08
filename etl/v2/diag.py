"""python3 -m etl.v2.diag key[,key...] [--around N] -- why a document's labels differ from today's (read-only): today's
labels, v2's units with their scopes, the openers v2 refused and why, and the paragraphs around each label lost."""
import re, sys

from etl.v2 import gate, tree as t4

gate._init()
keys = sys.argv[1].split(",")
around = int(sys.argv[sys.argv.index("--around") + 1]) if "--around" in sys.argv else 2
for key in keys:
    row = next(r for r in gate.rows({key}, None))
    prof, engine, paras, st, tree, info, ch = gate.build(row)
    with gate._w["db"].cursor() as cur:
        cur.execute("SELECT label FROM chunks WHERE doc_key = %s AND label IS NOT NULL ORDER BY seq", (key,))
        old = [r[0] for r in cur.fetchall()]
    gate._w["db"].rollback()
    new = [(s and s["label"], u["label"]) for s, u in t4.units(tree) if u["kind"] in ("unit", "schedule")]
    print(f"## {key} ({engine}) {row[1].strip()[:80]}")
    print("  today:", old[:80])
    print("  v2   :", [f"{s}/{l}" if s else l for s, l in new][:80])
    print("  refused:", [(r["text"][:36], r["after"], r["why"]) for r in info["rejected"][:12]])
    for l in [l for l in old if l not in {x for _, x in new}][:4]:
        i = next((i for i, p in enumerate(paras) if re.match(rf"\s*{re.escape(l)}\s*\.\s", p["text"])), None)
        print(f"  lost {l}:", "not an opener in v2's paragraphs" if i is None else
              [paras[j]["text"][:80] for j in range(max(0, i - around), i + 1)])
