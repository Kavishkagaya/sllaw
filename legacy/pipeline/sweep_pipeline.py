"""Run the digital-PDF pipeline over a corpus. No DB — files in, files out."""
import sys, glob, json, os, traceback, importlib.util, contextlib, io
import pypdfium2 as pdfium

spec = importlib.util.spec_from_file_location("b3", "bind3.py")

def text_layer_chars(path):
    d = pdfium.PdfDocument(path)
    n = len(d)
    idx = range(0, n, max(1, n // 8))
    tot = 0
    for i in list(idx)[:8]:
        tot += len(d[i].get_textpage().get_text_range().strip())
    return n, tot / max(1, len(list(idx)[:8]))

rows = []
os.makedirs("sweep_out", exist_ok=True)
for p in sorted(glob.glob("corpus/*.pdf")):
    name = os.path.basename(p)[:-4]
    rec = {"file": name}
    try:
        pages, cpp = text_layer_chars(p)
        rec.update(pages=pages, chars_per_page=round(cpp))
        rec["kind"] = "digital" if cpp > 200 else ("scan" if cpp < 20 else "mixed")
        if rec["kind"] != "digital":
            rec["sections"] = 0; rec["with_note"] = 0
        else:
            out_md = f"sweep_out/{name}.md"; out_js = f"sweep_out/{name}.json"
            sys.argv = ["bind3.py", p, out_md, out_js]
            with contextlib.redirect_stdout(io.StringIO()):
                spec.loader.exec_module(importlib.util.module_from_spec(spec))
            secs = json.load(open(out_js))
            rec["sections"] = len(secs)
            rec["with_note"] = sum(1 for s in secs if s["marginal_note"])
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
    rows.append(rec)
    print(f"{name:8s} {rec.get('kind','?'):8s} {rec.get('pages','?'):>4}p "
          f"{rec.get('chars_per_page','?'):>6} ch/pg  "
          f"sections={rec.get('sections','-'):>4} with_note={rec.get('with_note','-'):>4}"
          f"{'  ERR:'+rec['error'] if 'error' in rec else ''}", flush=True)

json.dump(rows, open("sweep_out/summary.json","w"), indent=1)
d = [r for r in rows if r.get("kind")=="digital"]
print(f"\n{len(rows)} pdfs | digital {len(d)} | scan {sum(1 for r in rows if r.get('kind')=='scan')}")
print(f"sections total {sum(r.get('sections',0) for r in d)} | "
      f"with marginal note {sum(r.get('with_note',0) for r in d)}")
