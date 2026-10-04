#!/usr/bin/env python3
"""Step 2: extract every fetched file once and keep the engines' raw output.

  python3 -m etl.extract --limit 50     # pilot
  python3 -m etl.extract                # everything fetched but not yet extracted
  python3 -m etl.extract --no-chandra   # only files docling can do alone (no vLLM server up)

Per unique file (sha256): read the PDF from R2, count text-layer characters per
page, then route:
  pages with a text layer -> docling (whole file, OCR off)
  pages without one       -> Chandra 2 through its vLLM server (on ada)
Writes raw/<VERSION>/<sha256>.json.gz to R2 and sets raw_key/extracted_at on every
row with that sha256. What is stored is the engines' own output, untouched:
  docling: DoclingDocument dict, plus per page the parsed cells and layout predictions
  chandra: per page the model's raw HTML (data-label / data-bbox on a 0..bbox_scale
           grid of the rendered image), token count and image size
A file is written only when every page succeeded, so raw is never partial.
Bump VERSION when an engine or its parameters change; old raw stays in R2.
"""
import argparse, gzip, io, json, os, tempfile
from importlib.metadata import version

import psycopg2
import pypdfium2 as pdfium
from dotenv import load_dotenv

from etl.fetch import r2

load_dotenv()
VERSION = "v1"
# ponytail: >=20 text-layer chars = digital page. Cover/back pages of digital Acts are
# sparse but non-zero; scans are 0. Retune from the pilot if blank versos misroute.
MIN_CHARS = 20


def text_layer(pdf):
    """Per page: text-layer character count and size in PDF points."""
    doc, out = pdfium.PdfDocument(pdf), []
    for i in range(len(doc)):
        page = doc[i]
        w, h = page.get_size()
        out.append({"page_no": i + 1, "chars": len(page.get_textpage().get_text_range().strip()),
                    "width_pt": w, "height_pt": h})
    doc.close()
    return out


_docling = None
def docling(pdf, name):
    global _docling
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import DocumentStream, InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    params = {"do_ocr": False, "generate_parsed_pages": True}
    if _docling is None:
        # PyPdfium backend: the default backend fails on gazette PDFs (CLAUDE.md known issues)
        _docling = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(
            pipeline_options=PdfPipelineOptions(**params), backend=PyPdfiumDocumentBackend)})
    res = _docling.convert(DocumentStream(name=f"{name}.pdf", stream=io.BytesIO(pdf)))
    missing = [p.page_no for p in res.pages if p.parsed_page is None]
    if missing:
        raise RuntimeError(f"docling kept no parsed cells for pages {missing[:5]}")
    return {"version": version("docling"), "params": {**params, "backend": "pypdfium2"},
            "status": str(res.status), "document": res.document.export_to_dict(),
            "pages": [{"page_no": p.page_no,
                       "size": p.size.model_dump(mode="json") if p.size else None,
                       "parsed_page": p.parsed_page.model_dump(mode="json"),
                       "predictions": p.predictions.model_dump(mode="json")} for p in res.pages]}


_chandra = None
def chandra(pdf, pages):
    """pages: 0-based indices to OCR."""
    global _chandra
    from chandra.input import load_pdf_images
    from chandra.model import InferenceManager
    from chandra.model.schema import BatchInputItem
    from chandra.settings import settings
    _chandra = _chandra or InferenceManager(method="vllm")
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf)
        f.flush()
        images = load_pdf_images(f.name, pages)
    # ponytail: one batch per file; if the GPUs sit idle on short Acts, batch across files
    out = _chandra.generate([BatchInputItem(image=im, prompt_type="ocr_layout") for im in images])
    failed = [p + 1 for p, o in zip(pages, out) if o.error]
    if failed:
        raise RuntimeError(f"chandra failed on pages {failed[:5]}")
    return {"version": version("chandra-ocr"), "model": settings.MODEL_CHECKPOINT,
            "params": {"prompt_type": "ocr_layout", "image_dpi": settings.IMAGE_DPI,
                       "min_pdf_image_dim": settings.MIN_PDF_IMAGE_DIM,
                       "bbox_scale": settings.BBOX_SCALE, "max_output_tokens": settings.MAX_OUTPUT_TOKENS},
            "pages": [{"page_no": p + 1, "raw": o.raw, "token_count": o.token_count,
                       "image_size": o.page_box[2:]} for p, o in zip(pages, out)]}


def run(limit=None, use_chandra=True):
    s3, bucket = r2(), os.environ["R2_BUCKET"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute("SELECT sha256, min(r2_key) FROM documents WHERE r2_key IS NOT NULL AND raw_key IS NULL "
                "GROUP BY sha256 ORDER BY min(id) LIMIT %s", (limit,))
    rows, ok, bad, skipped = cur.fetchall(), 0, 0, 0
    for i, (sha, key) in enumerate(rows, 1):
        try:
            pdf = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            pages = text_layer(pdf)
            scan = [p["page_no"] - 1 for p in pages if p["chars"] < MIN_CHARS]
            if scan and not use_chandra:
                skipped += 1
                print(f"[{i}/{len(rows)}] {sha[:12]}: skip, {len(scan)} pages need Chandra", flush=True)
                continue
            raw = {"sha256": sha, "version": VERSION, "pages": pages,
                   "docling": docling(pdf, sha) if len(scan) < len(pages) else None,
                   "chandra": chandra(pdf, scan) if scan else None}
            rkey = f"raw/{VERSION}/{sha}.json.gz"
            s3.put_object(Bucket=bucket, Key=rkey, ContentType="application/gzip",
                          Body=gzip.compress(json.dumps(raw, ensure_ascii=False).encode()))
            cur.execute("UPDATE documents SET raw_key=%s, extracted_at=NOW(), error=NULL, updated_at=NOW() "
                        "WHERE sha256=%s", (rkey, sha))
            ok += 1
            msg = f"ok {len(pages)} pages ({len(scan)} via Chandra)"
        except Exception as e:
            conn.rollback()
            cur.execute("UPDATE documents SET error=%s, updated_at=NOW() WHERE sha256=%s",
                        (f"extract: {e}"[:500], sha))
            bad += 1
            msg = f"FAIL {e}"[:120]
        conn.commit()
        print(f"[{i}/{len(rows)}] {sha[:12]}: {msg}", flush=True)
    conn.close()
    print(f"\n{ok} extracted, {bad} failed, {skipped} skipped (failed and skipped stay queued)")


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--limit", type=int, help="extract at most N files (pilot)")
    a.add_argument("--no-chandra", action="store_true", help="skip files that have pages without a text layer")
    args = a.parse_args()
    run(args.limit, not args.no_chandra)


if __name__ == "__main__":
    main()
