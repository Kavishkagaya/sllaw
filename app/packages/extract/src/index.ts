import { docxExtractor } from "./docx";
import { NoText, type Extracted, type ExtractCtx, type Extractor } from "./extractor";
import { httpOcr, ocrImageExtractor, ocrPdfExtractor, type OcrProvider } from "./ocr";
import { pdfExtractor } from "./pdf";
import { textExtractor } from "./text";

/** The extractors tried in order: the first that accepts a file reads it. Without an OCR provider a scan is
 *  `no_text`; with one, its pages without a text layer are OCR'd and images are read too. */
export const extractors = (ocr?: OcrProvider | null): Extractor[] =>
  ocr ? [ocrPdfExtractor(ocr), docxExtractor, textExtractor, ocrImageExtractor(ocr)] : [pdfExtractor, docxExtractor, textExtractor];

export const defaultExtractors = extractors();

/** The extractor that would read a file, and its name@version: compare it with a file's extract_by to find files
 *  read by an older version. null when no extractor reads the format. */
export function extractorFor(mime: string, filename: string, xs = defaultExtractors) {
  const x = xs.find((e) => e.accepts(mime, filename));
  return x ? { extractor: x, by: `${x.name}@${x.version}` } : null;
}

/** Read a file's text with the first extractor that accepts it. Throws NoText when there is none to read. */
export async function extract(bytes: Uint8Array, mime: string, filename: string, xs = defaultExtractors, ctx?: ExtractCtx): Promise<Extracted> {
  const x = xs.find((e) => e.accepts(mime, filename));
  if (!x) throw new NoText("unsupported", `no extractor reads ${mime || "this format"} (${filename})`);
  const pages = await x.extract(bytes, mime, filename, ctx);
  return { by: `${x.name}@${x.version}`, pages, totalPages: pages.length };
}

export { docxExtractor, httpOcr, ocrImageExtractor, ocrPdfExtractor, pdfExtractor, textExtractor, type OcrProvider };
export { pdfPagesText } from "./pdf";
export { NoText, type Extracted, type ExtractCtx, type Extractor, type Page } from "./extractor";
