"""
detect_consolidated.py — Layout visualiser for consolidated statute PDFs

Renders docling cluster boxes on each page so you can see what the layout
detector is finding (and whether the column gap / marginal notes are detected).

Usage:
  .venv/bin/python3 detect_consolidated.py <pdf> [--pages N]

Output: layout_output_consolidated/<pdf_stem>_page_NNN.png
"""

import sys
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

# ── Config ────────────────────────────────────────────────────────────────────

DPI   = 150
SCALE = DPI / 72

COLORS = {
    "text":             "#2196F3",
    "title":            "#E91E63",
    "section_header":   "#9C27B0",
    "caption":          "#FF9800",
    "figure":           "#4CAF50",
    "table":            "#F44336",
    "formula":          "#00BCD4",
    "footnote":         "#795548",
    "page_footer":      "#607D8B",
    "page_header":      "#009688",
    "list_item":        "#3F51B5",
    "code":             "#FF5722",
    "picture":          "#8BC34A",
    "key_value_region": "#FF6F00",
}
DEFAULT_COLOR = "#9E9E9E"

GAP_COLOR    = (255, 80, 80, 120)   # red tint for detected column gap


# ── Helpers ───────────────────────────────────────────────────────────────────

def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def render_page(pdf_doc, pg_idx):
    page   = pdf_doc[pg_idx]
    bitmap = page.render(scale=SCALE)
    return bitmap.to_pil()


def find_gap(clusters):
    """Return (gap_left_px, gap_right_px) in pixel coords, or None."""
    intervals = []
    for cl in clusters:
        if cl.label.value in ("page_header", "page_footer"):
            continue
        for cell in cl.cells:
            xs = (cell.rect.r_x0, cell.rect.r_x1, cell.rect.r_x2, cell.rect.r_x3)
            x0, x1 = min(xs), max(xs)
            if x1 > x0:
                intervals.append((x0, x1))
    if not intervals:
        return None
    intervals.sort()
    merged = [list(intervals[0])]
    for x0, x1 in intervals[1:]:
        if x0 <= merged[-1][1] + 2:
            merged[-1][1] = max(merged[-1][1], x1)
        else:
            merged.append([x0, x1])
    if len(merged) < 2:
        return None
    best_gap, best = 0, None
    for i in range(len(merged) - 1):
        gap = merged[i + 1][0] - merged[i][1]
        if gap > best_gap:
            best_gap = gap
            best = (merged[i][1], merged[i + 1][0])
    if best_gap < 8:
        return None
    gl, gr = best
    return gl * SCALE, gr * SCALE


def draw_page(img, clusters, pg_idx):
    draw = ImageDraw.Draw(img, "RGBA")
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
    except Exception:
        font = ImageFont.load_default()

    # Draw column-gap highlight first (behind boxes)
    gap = find_gap(clusters)
    if gap:
        gl, gr = gap
        draw.rectangle([gl, 0, gr, img.height], fill=GAP_COLOR)
        draw.text((gl + 2, 4), "← column gap →", fill=(200, 50, 50), font=font)
    else:
        draw.text((4, 4), "no column gap detected", fill=(180, 0, 0), font=font)

    # Draw each cluster box
    for cl in clusters:
        label = cl.label.value if hasattr(cl.label, "value") else str(cl.label)
        conf  = cl.confidence if hasattr(cl, "confidence") else 1.0
        b     = cl.bbox
        x0, y0 = b.l * SCALE, b.t * SCALE
        x1, y1 = b.r * SCALE, b.b * SCALE

        color = COLORS.get(label, DEFAULT_COLOR)
        r, g, bl = hex_rgb(color)

        draw.rectangle([x0, y0, x1, y1], outline=(r, g, bl, 230), width=2)

        tag = f"{label} {conf:.0%}"
        lw  = len(tag) * 7 + 4
        draw.rectangle([x0, y0 - 14, x0 + lw, y0], fill=(r, g, bl, 200))
        draw.text((x0 + 2, y0 - 13), tag, fill="white", font=font)

    # Page number
    draw.text((4, img.height - 18), f"page {pg_idx + 1}", fill=(80, 80, 80), font=font)
    return img


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args      = sys.argv[1:]
    pdf_path  = Path(args[0]) if args else Path("document.pdf")
    max_pages = int(args[args.index("--pages") + 1]) if "--pages" in args else 5

    out_dir = Path("layout_output_consolidated")
    out_dir.mkdir(exist_ok=True)

    print(f"Converting {pdf_path} (first {max_pages} pages) with docling...")
    opts = PdfPipelineOptions()
    opts.do_ocr = False
    opts.do_table_structure = False
    conv = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=opts,
                backend=PyPdfiumDocumentBackend,
            )
        }
    )
    result  = conv.convert(str(pdf_path.resolve()), page_range=(1, max_pages))
    pdf_doc = pdfium.PdfDocument(str(pdf_path))

    stem = pdf_path.stem
    for pg_idx in range(min(max_pages, len(result.pages))):
        clusters = result.pages[pg_idx].predictions.layout.clusters
        img      = render_page(pdf_doc, pg_idx)
        annotated = draw_page(img, clusters, pg_idx)

        out = out_dir / f"{stem}_page_{pg_idx + 1:03d}.png"
        annotated.save(out)

        gap     = find_gap(clusters)
        n_cells = sum(len(cl.cells) for cl in clusters)
        labels  = [cl.label.value for cl in clusters]
        print(f"  p{pg_idx+1:2d}: {len(clusters)} clusters  {n_cells} cells"
              f"  gap={'YES' if gap else 'no ':3s}  {labels}")

    print(f"\nDone → {out_dir}/")


if __name__ == "__main__":
    main()
