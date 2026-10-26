// The implementations the app runs the pipelines with. Swapping one (another store, extractor set, OCR provider,
// categorizer, vector DB) is a change to that package's default or to this file; the pipeline and the rows do not
// change. OCR is off until OCR_URL is set (extract's httpOcr): a scan is then `no_text` and costs nothing.
import { llmCategorizer } from "@sllaw/ai";
import { claimStep, endStep, fileById } from "@sllaw/db";
import { extract, extractors, httpOcr, type Extractor } from "@sllaw/extract";
import { fileIndex } from "@sllaw/search";
import { blobStore } from "@sllaw/storage";
import type { Deps, FileRows } from "./pipeline";

export const dbRows: FileRows = { get: fileById, claim: claimStep, end: endStep };

let xs: Extractor[] | null = null;
/** The extractors the app reads files with (OCR ones when OCR_URL is set). */
export const appExtractors = () => (xs ??= extractors(httpOcr()));

let deps: Deps | null = null;
export const appDeps = (): Deps =>
  (deps ??= {
    rows: dbRows,
    store: blobStore(),
    extract: (bytes, mime, name, ctx) => extract(bytes, mime, name, appExtractors(), ctx),
    categorizer: llmCategorizer,
    index: fileIndex(),
  });
