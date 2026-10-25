// The implementations the app runs the pipelines with. Swapping one (another store, extractor set, OCR provider,
// categorizer, vector DB) is a change to that package's default or to this file; the pipeline and the rows do not
// change. OCR is off unless OCR=vision: a scan is then `no_text` and costs nothing.
import { llmCategorizer, visionOcr } from "@sllaw/ai";
import { claimStep, endStep, fileById, scopesOfFile } from "@sllaw/db";
import { extract, extractors } from "@sllaw/extract";
import { fileIndex } from "@sllaw/search";
import { blobStore } from "@sllaw/storage";
import type { Deps, FileRows } from "./pipeline";

export const dbRows: FileRows = { get: fileById, claim: claimStep, end: endStep, scopes: scopesOfFile };

/** The OCR provider for a workspace's files (its calls are billed to that workspace), or null when OCR is off. */
export const ocrFor = (workspaceId: string) => (process.env.OCR === "vision" ? visionOcr(workspaceId) : null);

let deps: Deps | null = null;
export const appDeps = (): Deps =>
  (deps ??= {
    rows: dbRows,
    store: blobStore(),
    extract: (bytes, mime, name, { workspaceId }) => extract(bytes, mime, name, extractors(ocrFor(workspaceId))),
    categorizer: llmCategorizer,
    index: fileIndex(),
  });
