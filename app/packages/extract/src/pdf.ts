// PDFs with a text layer, via unpdf (pdf.js built for serverless). A page with almost no text is a scan; a file that
// is mostly scans needs OCR (not wired yet: docs/APP.md, File ingestion).
import { extractText } from "unpdf";
import { ext, NoText, type Extractor } from "./extractor";

const MIN_CHARS = 40; // a page with fewer letters than this has no text layer worth keeping (stamps, page numbers)

export const pdfExtractor: Extractor = {
  name: "unpdf",
  version: 1,
  accepts: (mime, filename) => mime === "application/pdf" || ext(filename) === "pdf",
  async extract(bytes) {
    // pdf.js may detach the buffer it is given: hand it a copy
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
    const pages = text.map((t, i) => ({ n: i + 1, text: clean(t) }));
    const withText = pages.filter((p) => p.text.replace(/\W/g, "").length >= MIN_CHARS).length;
    if (withText === 0 || withText < pages.length / 2)
      throw new NoText("needs_ocr", `${pages.length - withText} of ${pages.length} pages have no text layer`);
    return pages;
  },
};

const clean = (t: string) =>
  t
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
