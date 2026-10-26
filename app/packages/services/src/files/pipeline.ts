// The file pipelines (docs/APP.md, File ingestion). Three steps, each behind its own interface and joined only by
// the file's row and its folder in the blob store, so each runs, re-runs and is swapped on its own:
//   extract    original      -> extract.json (pages)            Extractor (@sllaw/extract)
//   categorize extract.json  -> card.json + category/meta       Categorizer (@sllaw/ai)
//   index      extract.json  -> chunks.json + vectors           FileIndex (@sllaw/search)
// Upload is the step before: the file reaches the store and the row says `stored`. A step runs when the row says
// pending and extract is done; categorize and index both read only its text, so they run at the same time. A step
// the file does not need is null. runFile runs them in one process (tests); ./workflow runs each as a retried Vercel
// Workflow step. Both go through runStep, the only writer of step state, which also writes every
// state it sets to a StateWriter: in a workflow, the run's stream, which the UI reads as server-sent events.
import type { Card, Categorizer } from "@sllaw/ai";
import type { FileRow, Step, StepEnd, StepError, StepState } from "@sllaw/db";
import { type ExtractCtx, type Extracted, NoText } from "@sllaw/extract";
import { chunkPages, type FileIndex, indexBy } from "@sllaw/search";
import { type BlobStore, getJson, putJson } from "@sllaw/storage";
import { isRetryable } from "./errors";

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
  claim(id: string, step: Step, runId?: string): Promise<FileRow | null>;
  /** The time written, or null when the step was no longer running, or (with runId) no longer this run's: reset or
   *  claimed by another run meanwhile. */
  end(id: string, step: Step, e: StepEnd, runId?: string): Promise<Date | null>;
}

/** One state change of a file, as the UI gets it. `at` is the time the row was written (ms): an event older than the
 *  row the UI already has is skipped, so a stream replayed from its start never turns a state back. */
export type FileEvent = {
  fileId: string;
  step: "upload" | Step;
  state: StepState | "stored" | "failed";
  error: StepError | null;
  at: number;
};

/** Where runStep reports each state it writes: the workflow run's stream, or nowhere (tests, scripts). */
export interface StateWriter {
  write(e: FileEvent): Promise<void>;
}
export const noWriter: StateWriter = { write: async () => {} };

export type Deps = {
  rows: FileRows;
  store: BlobStore;
  extract: (bytes: Uint8Array, mime: string, filename: string, ctx: ExtractCtx) => Promise<Extracted>;
  categorizer: Categorizer;
  index: FileIndex;
};

const stateOf = (f: FileRow, s: Step) => f[`${s}State`];

/** What runStep does when a step throws: record it as failed (default), or, while retries are left and the error is
 *  worth another try (./errors), put it back to pending with the error and throw, so the caller (a workflow step)
 *  retries it. An error not worth another try is recorded failed at once. */
export type RunOpts = {
  retriesLeft?: boolean;
  writer?: StateWriter;
  runId?: string;
  timeouts?: Partial<Record<Step, number>>;
};

/** How long each step may take (ms). Under Vercel's function limit (300 s by default, the workflow's step route
 *  included), so a slow step ends itself, is recorded and retried, rather than its function being cut off with the
 *  step left running. Raise them only with the function's maxDuration. A file needing longer (a very long scan) fails
 *  with the timeout after its 3 attempts. */
export const STEP_TIMEOUT: Record<Step, number> = { extract: 240_000, categorize: 90_000, index: 180_000 };

/** A step that ran out of time. Retryable: a slow model or OCR call is often quick the next time. */
export class StepTimeout extends Error {
  readonly retryable = true;
  constructor(step: Step, ms: number) {
    super(`${step} took longer than ${Math.round(ms / 1000)} s`);
    this.name = "StepTimeout";
  }
}

/** The step's work, given up when its signal aborts. The calls inside take the signal and stop too (fetch, the model,
 *  the index); work that cannot be stopped (parsing a PDF) is left to finish and its result dropped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {}); // once given up, its own later failure is nobody's
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Runs one step if it is due: claimed (pending -> running), run, ended. The end state; "busy" when another run holds
 *  the step; null when it was not run (not needed, done, or extract not done). With `runId`, a step this run left
 *  running (a retry after a cut-off attempt) is taken back at once. */
export async function runStep(
  id: string,
  step: Step,
  d: Deps,
  o: RunOpts = {},
): Promise<StepEnd["state"] | "busy" | null> {
  const w = o.writer ?? noWriter;
  const f = await d.rows.get(id);
  if (!f || f.uploadState !== "stored") return null;
  if (!["pending", "running"].includes(stateOf(f, step) ?? "")) return null;
  if (step !== "extract" && f.extractState !== "done") return null; // nothing to read yet, or never will be
  const claimed = await d.rows.claim(id, step, o.runId);
  if (!claimed) return "busy";
  await w.write({ fileId: id, step, state: "running", error: null, at: claimed.updatedAt.getTime() });
  const ms = o.timeouts?.[step] ?? STEP_TIMEOUT[step];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new StepTimeout(step, ms)), ms);
  let end: StepEnd;
  try {
    end = await untilAborted(STEP[step](claimed, d, ac.signal), ac.signal);
  } catch (e) {
    const error: StepError = { message: String((e as Error)?.message ?? e).slice(0, 1000), retryable: isRetryable(e) };
    if (o.retriesLeft && error.retryable) {
      const at = await d.rows.end(id, step, { state: "pending", error }, o.runId);
      if (at) await w.write({ fileId: id, step, state: "pending", error, at: at.getTime() });
      throw e;
    }
    end = { state: "failed", error };
  } finally {
    clearTimeout(timer);
  }
  const at = await d.rows.end(id, step, end, o.runId);
  if (!at) return null; // reset or claimed by another run while it ran: that run's states are the ones that count
  await w.write({ fileId: id, step, state: end.state, error: end.error ?? null, at: at.getTime() });
  return end.state;
}

/** Every step the file still needs: extract, then categorize and index side by side. A failed step is recorded and
 *  the others go on where they can. Safe to call twice at once or again later: a step is claimed before it runs. */
export async function runFile(id: string, d: Deps, only: readonly Step[] = ["extract", "categorize", "index"]) {
  const ran: Partial<Record<Step, string>> = {};
  const run = async (s: Step) => {
    if (!only.includes(s)) return;
    const r = await runStep(id, s, d);
    if (r && r !== "busy") ran[s] = r;
  };
  await run("extract");
  await Promise.all([run("categorize"), run("index")]);
  return ran;
}

type Pages = Pick<Extracted, "by" | "pages">;

const STEP: Record<Step, (f: FileRow, d: Deps, signal: AbortSignal) => Promise<StepEnd>> = {
  async extract(f, d, signal) {
    const blob = await d.store.get(keys.original(f.id));
    if (!blob)
      return {
        state: "failed",
        error: { message: "the original is not in the store: upload it again", retryable: false },
      };
    const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", blob.bytes as BufferSource)).toString("hex");
    try {
      // OCR fetches the file itself: a signed URL, good for the length of a step
      const x = await d.extract(blob.bytes, f.mime, f.name, {
        url: () => d.store.downloadUrl(keys.original(f.id), 15 * 60),
        signal,
      });
      await putJson(d.store, keys.extract(f.id), { by: x.by, pages: x.pages } satisfies Pages);
      return { state: "done", by: x.by, set: { sha256, pages: x.totalPages } };
    } catch (e) {
      // nothing to read: trying again reads the same bytes (until OCR is on or a new extractor reads the format)
      if (e instanceof NoText)
        return { state: "no_text", error: { message: `${e.reason}: ${e.message}`, retryable: false }, set: { sha256 } };
      throw e;
    }
  },

  async categorize(f, d, signal) {
    const x = await getJson<Pages>(d.store, keys.extract(f.id));
    if (!x)
      return { state: "failed", error: { message: "the text is missing: read the file again", retryable: false } };
    const card = await d.categorizer.categorize({
      workspaceId: f.workspaceId,
      filename: f.name,
      text: x.pages.map((p) => p.text).join("\n\n"),
      signal,
    });
    await putJson(d.store, keys.card(f.id), card);
    const { summary: _, docType, ...meta } = card;
    return { state: "done", by: d.categorizer.by, set: { category: docType, meta } };
  },

  async index(f, d, signal) {
    const x = await getJson<Pages>(d.store, keys.extract(f.id));
    if (!x)
      return { state: "failed", error: { message: "the text is missing: read the file again", retryable: false } };
    const chunks = chunkPages(f.id, x.pages);
    await putJson(d.store, keys.chunks(f.id), chunks);
    // no delete runs meanwhile: a file is deleted only once no run is busy with it (db markDeleting)
    if (chunks.length) await d.index.upsert(chunks, { workspaceId: f.workspaceId, scopes: f.scopes }, signal);
    else await d.index.remove(f.id, signal);
    return { state: "done", by: indexBy(d.index), set: { chunks: chunks.length } };
  },
};

export type { Card };
