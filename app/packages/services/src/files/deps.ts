// The implementations the app runs the pipelines with. Swapping one (another store, extractor set, categorizer, vector
// DB) is a change to that package's default or to this one line; the pipeline and the rows do not change.
import { llmCategorizer } from "@sllaw/ai";
import { claimStep, endStep, fileById, scopesOfFile } from "@sllaw/db";
import { extract } from "@sllaw/extract";
import { fileIndex } from "@sllaw/search";
import { blobStore } from "@sllaw/storage";
import type { Deps, FileRows } from "./pipeline";

export const dbRows: FileRows = { get: fileById, claim: claimStep, end: endStep, scopes: scopesOfFile };

let deps: Deps | null = null;
export const appDeps = (): Deps =>
  (deps ??= { rows: dbRows, store: blobStore(), extract, categorizer: llmCategorizer, index: fileIndex() });
