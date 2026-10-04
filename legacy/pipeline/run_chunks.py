import glob, os, json, importlib.util
_s = importlib.util.spec_from_file_location("ch", "chunks.py")
ch = importlib.util.module_from_spec(_s); _s.loader.exec_module(ch)
allc = []
os.makedirs("chunks_out", exist_ok=True)
for p in sorted(glob.glob("corpus/*.pdf")):
    name = os.path.basename(p)[:-4]
    try:
        cs = ch.chunks(p)
    except Exception as e:
        print(f"{name}: ERROR {e}"); continue
    if not cs: continue
    json.dump(cs, open(f"chunks_out/{name}.json","w"), indent=1)
    allc += cs
    notes = sum(1 for c in cs if c["note"])
    print(f"{name:7s} {len(cs):>4} chunks  notes {notes:>4}  avg {sum(len(c['text']) for c in cs)//len(cs):>5} ch  {cs[0]['act'][:52]}")
json.dump(allc, open("chunks_out/all.json","w"), indent=1)
print(f"\nTOTAL {len(allc)} chunks | with note {sum(1 for c in allc if c['note'])} "
      f"| avg {sum(len(c['text']) for c in allc)//len(allc)} chars")
