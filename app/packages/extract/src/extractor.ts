// Extraction: a file's bytes -> its text, page by page. One Extractor per format; the first that accepts a file
// reads it. A new format or a better engine (OCR, docling on the work host) is a new Extractor, nothing else changes.
// `version` goes into the file row (`extract_by`), so files read by an older version can be found and read again.
export type Page = { n: number; text: string }; // n from 1; a format without pages (docx, txt) is one page

export type Extracted = {
  by: string; // name@version of the extractor
  pages: Page[];
  totalPages: number;
};

/** Why a file has no text: no extractor reads its format, or it has none to read (a scan: needs OCR). */
export class NoText extends Error {
  constructor(
    readonly reason: "unsupported" | "needs_ocr",
    message: string,
  ) {
    super(message);
  }
}

/** A file the extractor for its format could not parse (a corrupt PDF, a .docx that is not a zip): trying again reads
 *  the same bytes, so it is not retried. */
export class Unreadable extends Error {}

/** What an extractor may need beyond the bytes: a signed URL to the file, for a service that fetches it (OCR). */
export type ExtractCtx = { url?: () => Promise<string | null> };

export interface Extractor {
  readonly name: string;
  readonly version: number;
  accepts(mime: string, filename: string): boolean;
  /** Throws NoText when the file holds no text this extractor can read. */
  extract(bytes: Uint8Array, mime: string, filename: string, ctx?: ExtractCtx): Promise<Page[]>;
}

export const ext = (filename: string) => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
