// OCR for scans: a provider (a cheap OCR API or a vision model) behind one interface. Only pages with no text layer
// are sent, in small PDFs of BATCH pages read in parallel, so a long scan takes about as long as a few batches.
// A provider is swapped by passing another one; its `by` goes into extract_by, so files read by the old one can be
// found and read again.
import { PDFDocument } from "pdf-lib";
import { ext, NoText, type Extractor, type Page } from "./extractor";
import { pdfPagesText } from "./pdf";

export interface OcrProvider {
  readonly by: string; // name@version, e.g. "vision:google/gemini-2.5-flash@1"
  /** Text of every page of a small document (a PDF of a few pages, or one image), in order. */
  ocr(file: { bytes: Uint8Array; mime: string }, pageCount: number): Promise<string[]>;
}

const BATCH = Number(process.env.OCR_BATCH_PAGES || 8);
const PARALLEL = Number(process.env.OCR_PARALLEL || 6);

/** Text-layer PDFs as pdfExtractor reads them; pages without a text layer are OCR'd. */
export function ocrPdfExtractor(provider: OcrProvider): Extractor {
  return {
    name: `unpdf+ocr:${provider.by}`,
    version: 1,
    accepts: (mime, filename) => mime === "application/pdf" || ext(filename) === "pdf",
    async extract(bytes) {
      const { pages, empty } = await pdfPagesText(bytes);
      if (!empty.length) return pages;
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const batches = chunk(empty, BATCH);
      const texts = await pool(batches, PARALLEL, async (nums) => {
        const doc = await PDFDocument.create();
        for (const p of await doc.copyPages(src, nums.map((n) => n - 1))) doc.addPage(p);
        const out = await provider.ocr({ bytes: await doc.save(), mime: "application/pdf" }, nums.length);
        if (out.length !== nums.length) throw new Error(`ocr: ${out.length} pages back for ${nums.length}`);
        return out;
      });
      const byPage = new Map(batches.flat().map((n, i) => [n, texts.flat()[i]!.trim()]));
      const merged = pages.map((p) => (byPage.has(p.n) ? { n: p.n, text: byPage.get(p.n)! } : p));
      if (!merged.some((p) => p.text)) throw new NoText("needs_ocr", "OCR found no text");
      return merged;
    },
  };
}

const IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff"]);

/** A photo or scan of one page. */
export function ocrImageExtractor(provider: OcrProvider): Extractor {
  return {
    name: `ocr:${provider.by}`,
    version: 1,
    accepts: (mime, filename) => mime.startsWith("image/") || IMAGES.has(ext(filename)),
    async extract(bytes, mime) {
      const [text = ""] = await provider.ocr({ bytes, mime }, 1);
      if (!text.trim()) throw new NoText("needs_ocr", "OCR found no text");
      return [{ n: 1, text: text.trim() }] satisfies Page[];
    },
  };
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Map with at most `n` calls in flight; results in input order. */
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]!);
    }
  }));
  return out;
}
