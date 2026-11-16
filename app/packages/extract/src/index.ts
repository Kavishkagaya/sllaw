import { docxExtractor } from "./docx";
import { type ExtractCtx, type Extracted, type Extractor, NoText, type Page, Unreadable } from "./extractor";
import { httpOcr, mistralOcr, type OcrProvider, ocrFromEnv, ocrImageExtractor, ocrPdfExtractor } from "./ocr";
import { fullTextPdfExtractor, pdfExtractor } from "./pdf";
import { textExtractor } from "./text";

/** The extractors tried in order: the first that accepts a file reads it (one that finds it needs OCR passes it on to
 *  the next that accepts it). Without an OCR provider a scan is `no_text`; with one, a PDF's pages without a text layer
 *  are OCR'd and images are read too, and extract_by names OCR only when it ran. */
export const extractors = (ocr?: OcrProvider | null): Extractor[] =>
  ocr
    ? [fullTextPdfExtractor, ocrPdfExtractor(ocr), docxExtractor, textExtractor, ocrImageExtractor(ocr)]
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
  const accepting = xs.filter((e) => e.accepts(mime, filename));
  if (!accepting.length) throw new NoText("unsupported", `no extractor reads ${mime || "this format"} (${filename})`);
  for (const [i, x] of accepting.entries()) {
    const pages = await readWith(x, bytes, mime, filename, ctx, i < accepting.length - 1);
    if (pages) return { by: `${x.name}@${x.version}`, pages, totalPages: pages.length };
  }
  throw new Error("unreachable"); // the last extractor returns pages or throws
}

/** One extractor's pages; null when it finds the file needs OCR and another extractor may read it (`more`). */
async function readWith(
  x: Extractor,
  bytes: Uint8Array,
  mime: string,
  filename: string,
  ctx: ExtractCtx | undefined,
  more: boolean,
): Promise<Page[] | null> {
  try {
    return await x.extract(bytes, mime, filename, ctx);
  } catch (e) {
    if (more && e instanceof NoText && e.reason === "needs_ocr") return null;
    // a service's error (OCR) says itself whether to try again; anything else came from parsing these bytes
    // (the step's timeout carries retryable: it passes through too)
    const err = (e ?? {}) as { status?: unknown; retryable?: unknown };
    const told = e instanceof NoText || typeof err.status === "number" || typeof err.retryable === "boolean";
    if (told) throw e;
    throw new Unreadable(`${x.name} could not read ${filename}: ${(e as Error)?.message ?? e}`);
  }
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
