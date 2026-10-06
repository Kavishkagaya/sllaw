#!/usr/bin/env python3
"""Step 2: extract every fetched file once and keep the engines' raw output.

  python3 -m etl.extract --limit 50     # pilot
  python3 -m etl.extract                # everything fetched but not yet extracted
  python3 -m etl.extract --no-ocr       # only files with a text layer (no OCR)
  python3 -m etl.extract --before 2000 --limit 5   # scans only (OCR pilot)
  python3 -m etl.extract --recheck-ocr  # re-queue files whose OCR-layer pages were not OCR'd
  python3 -m etl.extract --shard 0/3    # one of 3 workers side by side (and 1/3, 2/3)

Per unique file (sha256): read the PDF from R2, count text-layer characters per
page, then route:
  any page with a text layer      -> docling (whole file, OCR off)
  pages with no text but an image -> Surya OCR inside docling (on ada's GPU; Chandra until 2026-10-06)
  pages whose text is an OCR layer over an image (fonts named '*Minion Pro-21633', 2008 scans)
                                  -> Surya too, whole page: that OCR is poor ("Rath11t1jotlzi")
  pages with neither (blank)      -> nothing; recorded in `pages` only
Writes raw/<VERSION>/<sha256>.json.gz to R2 and sets raw_key/extracted_at on every
row with that sha256. What is stored is the engines' own output, untouched:
  docling: DoclingDocument dict, plus per page word/line cells (with font names, or Surya's OCR
           cells on scanned pages) and layout predictions incl. empty clusters; backend
           docling_parse, pypdfium fallback; params say whether and how Surya ran
  chandra: (files extracted before 2026-10-06) per page the model's raw HTML (data-label /
           data-bbox on a 0..bbox_scale grid of the rendered image), token count and image size
A file is written only when every page succeeded, so raw is never partial.
Bump VERSION when an engine or its parameters change; old raw stays in R2.
"""
import argparse, ctypes, gzip, hashlib, io, json, os, time
from importlib.metadata import version

import psycopg2
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from dotenv import load_dotenv

from etl.fetch import r2

load_dotenv()
VERSION = "v2"   # v1 (pilot, 20 files): pypdfium backend, no word cells or fonts
# A page is OCR'd only if it has (almost) no text layer AND carries an image, i.e.
# it is a scan. Blank versos in digital Acts have neither and are left alone: the 2026-10-04
# pilot showed 1-2 such pages in nearly every digital Act.
MIN_CHARS = 20


_get_font_name = getattr(pdfium_c, "FPDFFont_GetBaseFontName", None) or pdfium_c.FPDFFont_GetFontName  # pdfium < 6xxx


def font_name(obj):
    buf = ctypes.create_string_buffer(256)
    _get_font_name(pdfium_c.FPDFTextObj_GetFont(obj.raw), buf, 256)
    return buf.value.decode(errors="replace")


def text_layer(pdf):
    """Per page: text-layer character count, image-object count, size in PDF points, and whether
    the text is an OCR layer: fonts an OCR tool made up, named '*Minion Pro-21633', drawn under
    the page image (2008 scans; visible render mode, so only the font names give it away)."""
    doc, out = pdfium.PdfDocument(pdf), []
    for i in range(len(doc)):
        page = doc[i]
        w, h = page.get_size()
        texts = [font_name(o) for o in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_TEXT])]
        out.append({"page_no": i + 1, "chars": len(page.get_textpage().get_text_range().strip()),
                    "images": len(list(page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE]))),
                    "ocr_layer": bool(texts) and sum(f.startswith("*") for f in texts) > len(texts) / 2,
                    "width_pt": w, "height_pt": h})
    doc.close()
    return out


def is_scan(p):
    """A page to OCR: an image with no text on it, or only someone else's OCR of it."""
    return bool(p["images"]) and (p["chars"] < MIN_CHARS or p.get("ocr_layer", False))


_docling = {}
def docling(pdf, name, digital_pages, ocr=None):
    """docling_parse backend: word cells with font names (bold/italic, FM-font detection).
    Falls back to pypdfium (line cells only, no fonts) if it raises or comes back empty on
    pages that have a text layer; CLAUDE.md records docling_parse failing on gazette PDFs.
    ocr: None (text layer only) | "scan" (Surya OCRs only where a page has no text, so digital pages
    keep their text layer) | "force" (Surya re-reads whole pages: scans carrying someone else's
    poor OCR layer). Surya replaced Chandra on 2026-10-06 (docs/PIPELINE.md)."""
    from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import DocumentStream, InputFormat
    from docling.datamodel.pipeline_options import LayoutOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    params = {"do_ocr": bool(ocr), "generate_parsed_pages": True, "keep_empty_clusters": True}
    if ocr:
        params.update({"ocr_engine": "surya", "surya_version": version("surya-ocr"),
                       "plugin": "docling-surya " + version("docling-surya"), "force_full_page_ocr": ocr == "force"})
    res = None
    for backend_name, backend in (("docling_parse", DoclingParseDocumentBackend),
                                  ("pypdfium", PyPdfiumDocumentBackend)):
        if (backend_name, ocr) not in _docling:
            opts = dict(do_ocr=False)
            if ocr:
                from docling_surya import SuryaOcrOptions
                opts = dict(do_ocr=True, ocr_model="suryaocr", allow_external_plugins=True,
                            ocr_options=SuryaOcrOptions(lang=["en"], use_gpu=True, force_full_page_ocr=ocr == "force"))
            _docling[(backend_name, ocr)] = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(
                pipeline_options=PdfPipelineOptions(generate_parsed_pages=True,
                                                    layout_options=LayoutOptions(keep_empty_clusters=True), **opts),
                backend=backend)})
        try:
            res = _docling[(backend_name, ocr)].convert(DocumentStream(name=f"{name}.pdf", stream=io.BytesIO(pdf)))
        except Exception as e:
            fallback_reason = f"{backend_name} raised: {e}"[:300]
            continue
        cells = {p.page_no: len(p.parsed_page.word_cells) + len(p.parsed_page.textline_cells)
                 for p in res.pages if p.parsed_page}
        empty = [n for n in digital_pages if not cells.get(n)]
        if not empty:
            break
        fallback_reason = f"{backend_name}: no cells on text pages {empty[:5]}"
    else:
        raise RuntimeError(fallback_reason)
    return {"version": version("docling"), "backend": backend_name,
            "fallback_reason": None if backend_name == "docling_parse" else fallback_reason,
            "params": params, "status": str(res.status), "document": res.document.export_to_dict(),
            "pages": [{"page_no": p.page_no,
                       "size": p.size.model_dump(mode="json") if p.size else None,
                       "parsed_page": p.parsed_page.model_dump(mode="json") if p.parsed_page else None,
                       "predictions": p.predictions.model_dump(mode="json")} for p in res.pages]}


def docling_html(html, name):
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter
    res = DocumentConverter().convert(DocumentStream(name=f"{name}.html", stream=io.BytesIO(html)))
    return {"version": version("docling"), "status": str(res.status), "document": res.document.export_to_dict()}


def connect(tries=5):
    """Retries: ada's resolver sometimes fails for a moment ("Temporary failure in name
    resolution", 2026-10-04)."""
    for i in range(tries):
        try:
            return psycopg2.connect(os.environ["DATABASE_URL"])
        except psycopg2.OperationalError:
            if i == tries - 1:
                raise
            time.sleep(5 * 2 ** i)


def write(sql, args):
    """One short-lived connection per write: an OCR'd file can take minutes, and Neon closes a
    connection left idle that long (SSL connection closed unexpectedly, 2026-10-04)."""
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, args)
    finally:
        conn.close()


def queue(before, limit, lang, tried, shard=None):
    conn = connect()
    with conn.cursor() as cur:
        cur.execute("SELECT sha256, min(r2_key) FROM documents WHERE r2_key IS NOT NULL AND raw_key IS NULL "
                    "AND (%s::text IS NULL OR doc_date < %s) AND (%s::text IS NULL OR meta->>'lang' = %s) "
                    "GROUP BY sha256 ORDER BY min(id) LIMIT %s", (before, before, lang, lang, limit))
        # the share: a hash of the file seeded per run, so a restart deals what's left evenly again
        # (an unseeded hash left all 126 remaining files in one share, 2026-10-06)
        rows = [r for r in cur.fetchall() if r[0] not in tried
                and (shard is None or int(hashlib.md5((shard[2] + r[0]).encode()).hexdigest()[:8], 16)
                     % shard[1] == shard[0])]
    conn.close()
    return rows


def run(limit=None, use_ocr=True, before=None, lang="ENGLISH", shard=None):
    """lang: only files in this language (decision 2026-10-05: English only; None = all). When the
    queue runs out it looks again, so files fetched meanwhile are picked up; each is tried once."""
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    tried, ok, bad, skipped = set(), 0, 0, 0
    while (rows := queue(before, limit, lang, tried, shard)):
        tried |= {r[0] for r in rows}
        run_batch(rows, s3, bucket, use_ocr, counts := [0, 0, 0])
        ok, bad, skipped = ok + counts[0], bad + counts[1], skipped + counts[2]
        if limit:
            break
    print(f"\n{ok} extracted, {bad} failed, {skipped} skipped (failed and skipped stay queued)")


def run_batch(rows, s3, bucket, use_ocr, counts):
    ok, bad, skipped = 0, 0, 0
    for i, (sha, key) in enumerate(rows, 1):
        t0 = time.time()
        try:
            pdf = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            if key.endswith(".html"):
                # an HTML Act (lankalaw.net): keep the page itself, whose two-cell rows pair each
                # marginal note with its section, plus docling's own HTML conversion
                raw = {"sha256": sha, "version": VERSION, "format": "html", "pages": [],
                       "html": pdf.decode("utf8", "replace"), "docling": docling_html(pdf, sha), "chandra": None}
                rkey = f"raw/{VERSION}/{sha}.json.gz"
                s3.put_object(Bucket=bucket, Key=rkey, ContentType="application/gzip",
                              Body=gzip.compress(json.dumps(raw, ensure_ascii=False).encode()))
                write("UPDATE documents SET raw_key=%s, extracted_at=NOW(), error=NULL, updated_at=NOW() "
                      "WHERE sha256=%s", (rkey, sha))
                ok += 1
                print(f"[{i}/{len(rows)}] {sha[:12]}: ok html in {time.time() - t0:.0f}s", flush=True)
                continue
            pages = text_layer(pdf)
            scan = [p["page_no"] - 1 for p in pages if is_scan(p)]
            digital = [p for p in pages if p["chars"] >= MIN_CHARS and not is_scan(p)]
            if scan and not use_ocr:
                skipped += 1
                print(f"[{i}/{len(rows)}] {sha[:12]}: skip, {len(scan)} pages need OCR", flush=True)
                continue
            # scans: Surya inside docling; "force" when a scan page carries someone else's OCR layer
            ocr = ("force" if any(pages[n].get("ocr_layer") for n in scan) else "scan") if scan else None
            raw = {"sha256": sha, "version": VERSION, "pages": pages,
                   "docling": docling(pdf, sha, [p["page_no"] for p in digital], ocr) if (digital or scan) else None,
                   "chandra": None}
            rkey = f"raw/{VERSION}/{sha}.json.gz"
            s3.put_object(Bucket=bucket, Key=rkey, ContentType="application/gzip",
                          Body=gzip.compress(json.dumps(raw, ensure_ascii=False).encode()))
            write("UPDATE documents SET raw_key=%s, extracted_at=NOW(), error=NULL, updated_at=NOW() "
                  "WHERE sha256=%s", (rkey, sha))
            ok += 1
            s = time.time() - t0
            msg = f"ok {len(pages)} pages ({len(scan)} via Surya) in {s:.0f}s, {len(pages) / s:.2f} pages/s"
        except Exception as e:
            try:
                write("UPDATE documents SET error=%s, updated_at=NOW() WHERE sha256=%s", (f"extract: {e}"[:500], sha))
            except Exception as e2:                # the failure is still logged below; the row stays queued
                e = f"{e} (error not saved: {e2})"
            bad += 1
            msg = f"FAIL {e}"[:160]
        print(f"[{i}/{len(rows)}] {sha[:12]}: {msg}", flush=True)
    counts[:] = [ok, bad, skipped]


def wrong_pages(raw):
    """Pages an earlier run sent to docling though they are scans with an OCR layer: docling's word
    cells there are in '/*'-named fonts (docling's spelling of '*Minion Pro-21633')."""
    done = {p["page_no"] for p in (raw.get("chandra") or {}).get("pages", [])}
    imgs = {p["page_no"]: p["images"] for p in raw["pages"]}
    bad = []
    for p in (raw.get("docling") or {}).get("pages", []):
        cells = (p.get("parsed_page") or {}).get("word_cells") or []
        if (cells and imgs.get(p["page_no"]) and p["page_no"] not in done
                and sum(c.get("font_name", "").startswith("/*") for c in cells) > len(cells) / 2):
            bad.append(p["page_no"])
    return bad


def recheck(workers=8):
    """Re-queue (raw_key = NULL) every extracted file with OCR-layer pages that were not OCR'd.
    The next run re-extracts them and writes over the same raw/<VERSION>/<sha256>.json.gz
    (decision 2026-10-04: fixed in place, no version bump)."""
    from concurrent.futures import ThreadPoolExecutor
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT sha256, raw_key FROM documents WHERE raw_key IS NOT NULL")
    rows = cur.fetchall()

    def check(row):
        raw = json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=row[1])["Body"].read()))
        return row[0], wrong_pages(raw)
    found = 0
    with ThreadPoolExecutor(workers) as ex:
        for i, (sha, bad) in enumerate(ex.map(check, rows), 1):
            if bad:
                found += 1
                cur.execute("UPDATE documents SET raw_key = NULL, extracted_at = NULL, updated_at = NOW() "
                            "WHERE sha256 = %s", (sha,))
                conn.commit()
                print(f"[{i}/{len(rows)}] {sha[:12]}: {len(bad)} OCR-layer pages {bad[:6]} -> re-queued", flush=True)
            elif i % 200 == 0:
                print(f"[{i}/{len(rows)}] checked, {found} re-queued", flush=True)
    conn.close()
    print(f"\n{found} of {len(rows)} files re-queued")


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--limit", type=int, help="extract at most N files (pilot)")
    a.add_argument("--no-ocr", action="store_true", help="skip files that have pages needing OCR")
    a.add_argument("--before", help="only documents dated before this, e.g. 2000 (pilot on scans)")
    a.add_argument("--lang", default="ENGLISH", help="ENGLISH (default), SINHALA, TAMIL, or all")
    a.add_argument("--shard", help="i/N[/seed]: this worker takes part i of N of the queue (by a hash of the "
                                   "file seeded with seed; use the same seed for all N), so N "
                                   "workers run side by side, so digital and scanned files overlap")
    a.add_argument("--recheck-ocr", action="store_true",
                   help="re-queue extracted files whose OCR-layer scan pages went to docling, then exit")
    args = a.parse_args()
    if args.recheck_ocr:
        return recheck()
    if args.shard:                                   # "i/N" or "i/N/seed"
        i, n, *seed = args.shard.split("/")
        shard = (int(i), int(n), seed[0] if seed else "")
    else:
        shard = None
    run(args.limit, not args.no_ocr, args.before, None if args.lang.lower() == "all" else args.lang.upper(), shard)


if __name__ == "__main__":
    main()
