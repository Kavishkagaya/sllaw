// The implementations the app runs the pipelines with. Swapping one (another store, extractor set, OCR provider,
// categorizer, vector DB) is a change to that package's default or to this file; the pipeline and the rows do not
// change. OCR is the gateway's vision model (MODEL_OCR) unless OCR_PROVIDER=mistral or OCR_URL picks another, or
// OCR_PROVIDER=off turns it off (a scan is then `no_text` and costs nothing).
import { gatewayOcr, llmCategorizer } from "@sllaw/ai";
import { claimStep, endStep, fileById } from "@sllaw/db";
import { type Extractor, extract, extractors, ocrFromEnv } from "@sllaw/extract";
import { fileIndex } from "@sllaw/search";
import { blobStore } from "@sllaw/storage";
import { checkSpend } from "../limits";
import type { Deps, FileRows } from "./pipeline";
import "../usage"; // metered usage goes to the database: workflow steps load this file, not services' index

export const dbRows: FileRows = { get: fileById, claim: claimStep, end: endStep };

let xs: Extractor[] | null = null;
/** The extractors the app reads files with, OCR included unless OCR_PROVIDER=off. */
export const appExtractors = () =>
  (xs ??= extractors(process.env.OCR_PROVIDER === "off" ? null : (ocrFromEnv() ?? gatewayOcr())));

let deps: Deps | null = null;
export const appDeps = (): Deps =>
  (deps ??= {
    rows: dbRows,
    store: blobStore(),
    extract: (bytes, mime, name, ctx) => extract(bytes, mime, name, appExtractors(), ctx),
    categorizer: llmCategorizer,
    index: fileIndex(),
    budget: (id) => checkSpend({ id }), // admins are not exempt mid-file (no user row here); staff only
  });
