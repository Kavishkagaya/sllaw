from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import pypdfium2 as pdfium

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.base_models import InputFormat
from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend

PDF_PATH = "document.pdf"
OUTPUT_DIR = Path("layout_output_docling")
OUTPUT_DIR.mkdir(exist_ok=True)
MAX_PAGES = 5

DPI = 150
SCALE = DPI / 72

# x-coordinate split thresholds (in PDF points, TOPLEFT origin)
RECTO_MARGIN_X = 283   # recto pages: cells with center_x > this → right margin
VERSO_MARGIN_X = 100   # verso pages: cells with center_x < this → left margin

COLORS = {
    "text": "#2196F3",
    "title": "#E91E63",
    "section_header": "#9C27B0",
    "caption": "#FF9800",
    "figure": "#4CAF50",
    "table": "#F44336",
    "formula": "#00BCD4",
    "footnote": "#795548",
    "page_footer": "#607D8B",
    "page_header": "#009688",
    "list_item": "#3F51B5",
    "code": "#FF5722",
    "picture": "#8BC34A",
    "key_value_region": "#FF6F00",
    "marginal_note": "#E65100",
}
DEFAULT_COLOR = "#9E9E9E"

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def render_page(pdf_doc, page_idx):
    page = pdf_doc[page_idx]
    bitmap = page.render(scale=SCALE)
    return bitmap.to_pil()

def is_recto(clusters):
    """True if wide text clusters start near x≈38 (recto), False for verso (x≈106)."""
    starts = [
        c.bbox.l for c in clusters
        if (c.bbox.r - c.bbox.l) > 100
        and (c.label.value if hasattr(c.label, 'value') else str(c.label))
        not in ('page_header', 'page_footer')
    ]
    if not starts:
        return True
    return (sum(1 for x in starts if x < 75) > len(starts) / 2)

def cell_center_x(cell):
    return (cell.rect.r_x0 + cell.rect.r_x2) / 2

def cells_to_bbox(cells):
    """Tight bounding box over a list of cells (TOPLEFT coords)."""
    xs = [x for c in cells for x in (c.rect.r_x0, c.rect.r_x1, c.rect.r_x2, c.rect.r_x3)]
    ys = [y for c in cells for y in (c.rect.r_y0, c.rect.r_y1, c.rect.r_y2, c.rect.r_y3)]
    return min(xs), min(ys), max(xs), max(ys)

def cluster_items(cluster, recto):
    """
    Return list of (label, x0, y0, x1, y1, conf) in pixel coords.
    Splits any cluster whose cells straddle the column boundary so that
    marginal-column cells become a separate marginal_note box.
    """
    label = cluster.label.value if hasattr(cluster.label, 'value') else str(cluster.label)
    conf = cluster.confidence if hasattr(cluster, 'confidence') else 1.0
    b = cluster.bbox

    # Page headers/footers are never split
    if label in ('page_header', 'page_footer') or not cluster.cells:
        return [(label, b.l * SCALE, b.t * SCALE, b.r * SCALE, b.b * SCALE, conf)]

    threshold = RECTO_MARGIN_X if recto else VERSO_MARGIN_X

    main_cells, margin_cells = [], []
    for cell in cluster.cells:
        cx = cell_center_x(cell)
        in_margin = (cx > threshold) if recto else (cx < threshold)
        (margin_cells if in_margin else main_cells).append(cell)

    # Entire cluster is in the margin → relabel
    if not main_cells:
        return [('marginal_note', b.l * SCALE, b.t * SCALE, b.r * SCALE, b.b * SCALE, conf)]

    items = []
    x0, y0, x1, y1 = cells_to_bbox(main_cells)
    items.append((label, x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE, conf))

    if margin_cells:
        x0, y0, x1, y1 = cells_to_bbox(margin_cells)
        items.append(('marginal_note', x0 * SCALE, y0 * SCALE, x1 * SCALE, y1 * SCALE, conf))

    return items

def draw_boxes(image, items):
    draw = ImageDraw.Draw(image, "RGBA")
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
    except Exception:
        font = ImageFont.load_default()

    for label, x0, y0, x1, y1, extra in items:
        color = COLORS.get(label, DEFAULT_COLOR)
        r, g, b = hex_to_rgb(color)

        draw.rectangle([x0, y0, x1, y1], outline=(r, g, b, 230), width=2)
        if isinstance(extra, float):
            tag = f"{label.replace('_', ' ').title()} {extra:.0%}"
        else:
            tag = str(extra)[:40]
        lw = len(tag) * 7 + 4
        draw.rectangle([x0, y0 - 14, x0 + lw, y0], fill=(r, g, b, 200))
        draw.text((x0 + 2, y0 - 13), tag, fill="white", font=font)

    return image

def main():
    print("Setting up docling converter...")
    pipeline_opts = PdfPipelineOptions()
    pipeline_opts.do_ocr = False
    pipeline_opts.do_table_structure = True

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_opts,
                backend=PyPdfiumDocumentBackend,
            )
        }
    )

    pdf_abs = str(Path(PDF_PATH).resolve())
    print(f"Converting {pdf_abs} (first {MAX_PAGES} pages)...")
    result = converter.convert(pdf_abs, page_range=(1, MAX_PAGES))

    print("Loading PDF for rendering...")
    pdf_doc = pdfium.PdfDocument(PDF_PATH)

    print(f"Rendering {MAX_PAGES} pages with boxes...")
    for pg_idx in range(MAX_PAGES):
        img = render_page(pdf_doc, pg_idx)
        pg = result.pages[pg_idx]

        # Raw text cells from the PDF — one box per text run, before any layout classification
        items = []
        for cluster in pg.predictions.layout.clusters:
            for cell in cluster.cells:
                r = cell.rect  # CoordOrigin.TOPLEFT
                xs = (r.r_x0, r.r_x1, r.r_x2, r.r_x3)
                ys = (r.r_y0, r.r_y1, r.r_y2, r.r_y3)
                x0, y0 = min(xs) * SCALE, min(ys) * SCALE
                x1, y1 = max(xs) * SCALE, max(ys) * SCALE
                items.append(("cell", x0, y0, x1, y1, cell.text))

        annotated = draw_boxes(img.copy(), items)

        out_path = OUTPUT_DIR / f"page_{pg_idx+1:03d}.png"
        annotated.save(out_path)
        print(f"  Page {pg_idx+1}: {len(items)} raw cells — saved: {out_path}")

    print(f"\nDone. Output in: {OUTPUT_DIR}/")

if __name__ == "__main__":
    main()
