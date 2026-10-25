// The implementations the app runs the pipelines with. Swapping one (another store, extractor set, OCR provider,
// categorizer, vector DB) is a change to that package's default or to this file; the pipeline and the rows do not
// change. OCR is off until OCR_URL is set (extract's httpOcr): a scan is then `no_text` and costs nothing.
import { llmCategorizer } from "@sllaw/ai";
import { claimStep, endStep, fileById, scopesOfFile } from "@sllaw/db";
import { extract, extractors, httpOcr } from "@sllaw/extract";
import { fileIndex } from "@sllaw/search";
import { blobStore } from "@sllaw/storage";
import type { Deps, FileRows } from "./pipeline";

export const dbRows: FileRows = { get: fileById, claim: claimStep, end: endStep, scopes: scopesOfFile };

let deps: Deps | null = null;
export const appDeps = (): Deps =>
  (deps ??= {
    rows: dbRows,
    store: blobStore(),
    extract: (bytes, mime, name, ctx) => extract(bytes, mime, name, extractors(httpOcr()), ctx),
    categorizer: llmCategorizer,
    index: fileIndex(),
  });
