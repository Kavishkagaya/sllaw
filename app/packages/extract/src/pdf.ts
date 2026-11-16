// PDFs with a text layer, via unpdf (pdf.js built for serverless). A page with almost no text is a scan; a file that
// is mostly scans needs OCR: ocrPdfExtractor (./ocr) reads those pages when an OCR provider is set.
import { extractImages, extractText, getDocumentProxy } from "unpdf";
import { type Extractor, ext, NoText, type Page } from "./extractor";
import { png } from "./png";

const MIN_CHARS = 40; // a page with fewer letters than this has no text layer worth keeping (stamps, page numbers)

/** Every page's text layer, and the pages that have none (scans). */
export async function pdfPagesText(bytes: Uint8Array): Promise<{ pages: Page[]; empty: number[] }> {
  // pdf.js may detach the buffer it is given: hand it a copy
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  const pages = text.map((t, i) => ({ n: i + 1, text: clean(t) }));
  return { pages, empty: pages.filter((p) => p.text.replace(/\W/g, "").length < MIN_CHARS).map((p) => p.n) };
}

/** A scanned PDF's page images, one page at a time (a scan is one image a page, sometimes several strips), as
 *  PNGs: decoded when asked, so a long scan is never all in memory at once. close() when done. */
export async function pdfPageImages(bytes: Uint8Array) {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  return {
    async page(n: number): Promise<Uint8Array[]> {
      const imgs = await extractImages(doc, n);
      return imgs
        .filter((i) => i.width >= 200 && i.height >= 200)
        .map((i) => png(i.data, i.width, i.height, i.channels));
    },
    close: () => doc.loadingTask.destroy(),
  };
}

export const pdfExtractor: Extractor = {
  name: "unpdf",
  version: 1,
  accepts: (mime, filename) => mime === "application/pdf" || ext(filename) === "pdf",
  async extract(bytes) {
    const { pages, empty } = await pdfPagesText(bytes);
    if (empty.length === pages.length || empty.length > pages.length / 2)
      throw new NoText("needs_ocr", `${empty.length} of ${pages.length} pages have no text layer`);
    return pages;
  },
};

/** With OCR on: the text layer only when every page has one; otherwise needs_ocr, and the OCR extractor reads it. */
export const fullTextPdfExtractor: Extractor = {
  ...pdfExtractor,
  async extract(bytes) {
    const { pages, empty } = await pdfPagesText(bytes);
    if (empty.length) throw new NoText("needs_ocr", `${empty.length} of ${pages.length} pages have no text layer`);
    return pages;
  },
};

const clean = (t: string) =>
  t
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
