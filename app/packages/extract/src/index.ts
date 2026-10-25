import { docxExtractor } from "./docx";
import { NoText, type Extracted, type Extractor } from "./extractor";
import { pdfExtractor } from "./pdf";
import { textExtractor } from "./text";

/** The extractors tried in order: the first that accepts a file reads it. */
export const defaultExtractors: Extractor[] = [pdfExtractor, docxExtractor, textExtractor];

/** Read a file's text with the first extractor that accepts it. Throws NoText when there is none to read. */
/** The extractor that would read a file, and its name@version: compare it with a file's extract_by to find files
 *  read by an older version. null when no extractor reads the format. */
export function extractorFor(mime: string, filename: string, extractors = defaultExtractors) {
  const x = extractors.find((e) => e.accepts(mime, filename));
  return x ? { extractor: x, by: `${x.name}@${x.version}` } : null;
}

export async function extract(bytes: Uint8Array, mime: string, filename: string, extractors = defaultExtractors): Promise<Extracted> {
  const x = extractors.find((e) => e.accepts(mime, filename));
  if (!x) throw new NoText("unsupported", `no extractor reads ${mime || "this format"} (${filename})`);
  const pages = await x.extract(bytes, mime, filename);
  return { by: `${x.name}@${x.version}`, pages, totalPages: pages.length };
}

export { docxExtractor, pdfExtractor, textExtractor };
export { NoText, type Extracted, type Extractor, type Page } from "./extractor";
