// The file pipelines (docs/APP.md, File ingestion). Three steps, each behind its own interface and joined only by
// the file's row and its folder in the blob store, so each runs, re-runs and is swapped on its own:
//   extract    original      -> extract.json (pages)            Extractor (@sllaw/extract)
//   categorize extract.json  -> card.json + category/meta       Categorizer (@sllaw/ai)
//   index      extract.json  -> chunks.json + vectors           FileIndex (@sllaw/search)
// Upload is the step before: the file reaches the store and the row says `stored`. A step runs when the row says
// pending and extract is done; categorize and index both read only its text, so they run at the same time. A step
// the file does not need is null. runFile runs them in one process (tests, the sweep); ./workflow runs each as a
// retried Vercel Workflow step. Both go through runStep, the only writer of step state.
import type { Card, Categorizer } from "@sllaw/ai";
import type { FileRow, Step, StepEnd } from "@sllaw/db";
import { type ExtractCtx, type Extracted, NoText } from "@sllaw/extract";
import { chunkPages, type FileIndex, indexBy } from "@sllaw/search";
import { type BlobStore, getJson, putJson } from "@sllaw/storage";

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
  extract: (bytes: Uint8Array, mime: string, filename: string, ctx: ExtractCtx) => Promise<Extracted>;
  categorizer: Categorizer;
  index: FileIndex;
};

const stateOf = (f: FileRow, s: Step) => f[`${s}State`];

/** What runStep does when a step throws: record it as failed (default), or, while retries are left, put it back to
 *  pending with the error and throw, so the caller (a workflow step) retries it. */
export type OnError = { retriesLeft: boolean };

/** Runs one step if it is due: claimed (pending -> running), run, ended. The end state, or null when the step was
 *  not run (not needed, done, claimed by another run, or extract not done). */
export async function runStep(id: string, step: Step, d: Deps, onError?: OnError): Promise<StepEnd["state"] | null> {
  const f = await d.rows.get(id);
  if (!f || f.uploadState !== "stored") return null;
  if (!["pending", "running"].includes(stateOf(f, step) ?? "")) return null;
  if (step !== "extract" && f.extractState !== "done") return null; // nothing to read yet, or never will be
  const claimed = await d.rows.claim(id, step);
  if (!claimed) return null;
  let end: StepEnd;
  try {
    end = await STEP[step](claimed, d);
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 1000);
    if (onError?.retriesLeft) {
      await d.rows.end(id, step, { state: "pending", error });
      throw e;
    }
    end = { state: "failed", error };
  }
  await d.rows.end(id, step, end);
  return end.state;
}

/** Every step the file still needs: extract, then categorize and index side by side. A failed step is recorded and
 *  the others go on where they can. Safe to call twice at once or again later: a step is claimed before it runs. */
export async function runFile(id: string, d: Deps, only: readonly Step[] = ["extract", "categorize", "index"]) {
  const ran: Partial<Record<Step, string>> = {};
  const run = async (s: Step) => {
    if (!only.includes(s)) return;
    const r = await runStep(id, s, d);
    if (r) ran[s] = r;
  };
  await run("extract");
  await Promise.all([run("categorize"), run("index")]);
  return ran;
}

type Pages = Pick<Extracted, "by" | "pages">;

const STEP: Record<Step, (f: FileRow, d: Deps) => Promise<StepEnd>> = {
  async extract(f, d) {
    const blob = await d.store.get(keys.original(f.id));
    if (!blob) return { state: "failed", error: "the original is not in the store" };
    const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", blob.bytes as BufferSource)).toString("hex");
    try {
      // OCR fetches the file itself: a signed URL, good for the length of a step
      const x = await d.extract(blob.bytes, f.mime, f.name, {
        url: () => d.store.downloadUrl(keys.original(f.id), 15 * 60),
      });
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
    const card = await d.categorizer.categorize({
      workspaceId: f.workspaceId,
      filename: f.name,
      text: x.pages.map((p) => p.text).join("\n\n"),
    });
    await putJson(d.store, keys.card(f.id), card);
    const { summary: _, docType, ...meta } = card;
    return { state: "done", by: d.categorizer.by, set: { category: docType, meta } };
  },

  async index(f, d) {
    const x = await getJson<Pages>(d.store, keys.extract(f.id));
    if (!x) return { state: "failed", error: "extract.json is missing" };
    const chunks = chunkPages(f.id, x.pages);
    await putJson(d.store, keys.chunks(f.id), chunks);
    if (chunks.length) await d.index.upsert(chunks, { workspaceId: f.workspaceId, scopes: await d.rows.scopes(f) });
    else await d.index.remove(f.id);
    return { state: "done", by: indexBy(d.index), set: { chunks: chunks.length } };
  },
};

export type { Card };
