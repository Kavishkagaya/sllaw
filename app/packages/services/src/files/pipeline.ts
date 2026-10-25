// The file pipelines (docs/APP.md, File ingestion). Three steps, each behind its own interface and joined only by
// the file's row and its folder in the blob store, so each runs, re-runs and is swapped on its own:
//   extract    original      -> extract.json (pages)            Extractor (@sllaw/extract)
//   categorize extract.json  -> card.json + category/meta       Categorizer (@sllaw/ai)
//   index      extract.json  -> chunks.json + vectors           FileIndex (@sllaw/search)
// Upload is the step before: the file reaches the store and the row says `stored`. A step runs when the row says
// pending and extract is done (categorize and index read its text); a step the file does not need is null.
import type { Card, Categorizer } from "@sllaw/ai";
import type { FileRow, Step, StepEnd } from "@sllaw/db";
import { NoText, type Extracted } from "@sllaw/extract";
import { chunkPages, indexBy, type FileIndex } from "@sllaw/search";
import { getJson, putJson, type BlobStore } from "@sllaw/storage";

export const keys = {
  dir: (id: string) => `files/${id}/`,
  original: (id: string) => `files/${id}/original`,
  extract: (id: string) => `files/${id}/extract.json`,
  card: (id: string) => `files/${id}/card.json`,
  chunks: (id: string) => `files/${id}/chunks.json`,
};

/** The file rows, as the pipeline needs them (@sllaw/db implements it; tests use memory). */
export interface FileRows {
  get(id: string): Promise<FileRow | null>;
  claim(id: string, step: Step): Promise<FileRow | null>;
  end(id: string, step: Step, e: StepEnd): Promise<void>;
  scopes(f: FileRow): Promise<string[]>;
}

export type Deps = {
  rows: FileRows;
  store: BlobStore;
  extract: (bytes: Uint8Array, mime: string, filename: string) => Promise<Extracted>;
  categorizer: Categorizer;
  index: FileIndex;
};

const ORDER: Step[] = ["extract", "categorize", "index"];
const stateOf = (f: FileRow, s: Step) => f[`${s}State`];

/** Runs every step the file still needs, in order; a failed step is recorded and the others go on where they can.
 *  Safe to call twice at once or again later: a step is claimed before it runs. */
export async function runFile(id: string, d: Deps, only: readonly Step[] = ORDER) {
  const ran: Partial<Record<Step, string>> = {};
  for (const step of ORDER) {
    if (!only.includes(step)) continue;
    const f = await d.rows.get(id);
    if (!f || f.uploadState !== "stored") break;
    if (!["pending", "running"].includes(stateOf(f, step) ?? "")) continue;
    if (step !== "extract" && f.extractState !== "done") continue; // nothing to read yet, or never will be
    const claimed = await d.rows.claim(id, step);
    if (!claimed) continue;
    let end: StepEnd;
    try {
      end = await STEP[step](claimed, d);
    } catch (e) {
      end = { state: "failed", error: String((e as Error)?.message ?? e).slice(0, 1000) };
    }
    await d.rows.end(id, step, end);
    ran[step] = end.state;
  }
  return ran;
}

type Pages = Pick<Extracted, "by" | "pages">;

const STEP: Record<Step, (f: FileRow, d: Deps) => Promise<StepEnd>> = {
  async extract(f, d) {
    const blob = await d.store.get(keys.original(f.id));
    if (!blob) return { state: "failed", error: "the original is not in the store" };
    const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", blob.bytes as BufferSource)).toString("hex");
    try {
      const x = await d.extract(blob.bytes, f.mime, f.name);
      await putJson(d.store, keys.extract(f.id), { by: x.by, pages: x.pages } satisfies Pages);
      return { state: "done", by: x.by, set: { sha256, pages: x.totalPages } };
    } catch (e) {
      if (e instanceof NoText) return { state: "no_text", error: `${e.reason}: ${e.message}`, set: { sha256 } };
      throw e;
    }
  },

  async categorize(f, d) {
    const x = await getJson<Pages>(d.store, keys.extract(f.id));
    if (!x) return { state: "failed", error: "extract.json is missing" };
    const card = await d.categorizer.categorize({ workspaceId: f.workspaceId, filename: f.name, text: x.pages.map((p) => p.text).join("\n\n") });
    await putJson(d.store, keys.card(f.id), card);
    const { summary: _, docType, ...meta } = card;
    return { state: "done", by: d.categorizer.by, set: { category: docType, meta } };
  },

  async index(f, d) {
    const x = await getJson<Pages>(d.store, keys.extract(f.id));
    if (!x) return { state: "failed", error: "extract.json is missing" };
    const chunks = chunkPages(f.id, x.pages);
    await putJson(d.store, keys.chunks(f.id), chunks);
    if (chunks.length) await d.index.upsert(chunks, { workspaceId: f.workspaceId, scopes: await d.rows.scopes(f), docType: f.category });
    else await d.index.remove(f.id);
    return { state: "done", by: indexBy(d.index), set: { chunks: chunks.length } };
  },
};

export type { Card };
