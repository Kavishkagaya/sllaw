import { docxExtractor } from "./docx";
import { type ExtractCtx, type Extracted, type Extractor, NoText, type Page, Unreadable } from "./extractor";
import { httpOcr, mistralOcr, type OcrProvider, ocrFromEnv, ocrImageExtractor, ocrPdfExtractor } from "./ocr";
import { pdfExtractor } from "./pdf";
import { textExtractor } from "./text";

/** The extractors tried in order: the first that accepts a file reads it. Without an OCR provider a scan is
 *  `no_text`; with one, its pages without a text layer are OCR'd and images are read too. */
export const extractors = (ocr?: OcrProvider | null): Extractor[] =>
  ocr
    ? [ocrPdfExtractor(ocr), docxExtractor, textExtractor, ocrImageExtractor(ocr)]
    : [pdfExtractor, docxExtractor, textExtractor];

export const defaultExtractors = extractors();

/** The extractor that would read a file, and its name@version: compare it with a file's extract_by to find files
 *  read by an older version. null when no extractor reads the format. */
export function extractorFor(mime: string, filename: string, xs = defaultExtractors) {
  const x = xs.find((e) => e.accepts(mime, filename));
  return x ? { extractor: x, by: `${x.name}@${x.version}` } : null;
}

/** Read a file's text with the first extractor that accepts it. Throws NoText when there is none to read. */
export async function extract(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  xs = defaultExtractors,
  ctx?: ExtractCtx,
): Promise<Extracted> {
  const x = xs.find((e) => e.accepts(mime, filename));
  if (!x) throw new NoText("unsupported", `no extractor reads ${mime || "this format"} (${filename})`);
  let pages: Page[];
  try {
    pages = await x.extract(bytes, mime, filename, ctx);
  } catch (e) {
    // a service's error (OCR) says itself whether to try again; anything else came from parsing these bytes
    // (the step's timeout carries retryable: it passes through too)
    const err = (e ?? {}) as { status?: unknown; retryable?: unknown };
    const told = e instanceof NoText || typeof err.status === "number" || typeof err.retryable === "boolean";
    if (told) throw e;
    throw new Unreadable(`${x.name} could not read ${filename}: ${(e as Error)?.message ?? e}`);
  }
  return { by: `${x.name}@${x.version}`, pages, totalPages: pages.length };
}

export { type ExtractCtx, type Extracted, type Extractor, NoText, type Page, Unreadable } from "./extractor";
export { pdfPagesText } from "./pdf";
export {
  docxExtractor,
  httpOcr,
  mistralOcr,
  type OcrProvider,
  ocrFromEnv,
  ocrImageExtractor,
  ocrPdfExtractor,
  pdfExtractor,
  textExtractor,
};
