// The file service: generic file processing. A caller (the case service, a user's own files, later attachments and
// logos) creates a file with the steps it needs and the scopes it is found under; this service stores it, runs those
// steps as a workflow run and reports their states, live, as server-sent events. It knows nothing of cases: who may
// add or see a file through a case is the case service's (../cases.ts). Functions taking an Account are for a
// user's own files (owner only); the rest take ids and trust their caller.
import {
  createFile,
  deleteFileRow,
  type FileRow,
  fileById,
  filesOfOwner,
  markDeleting,
  resetSteps,
  STEPS,
  type Step,
  type StepError,
  setRun,
  setUploaded,
} from "@sllaw/db";
import { getJson } from "@sllaw/storage";
import { getRun, start } from "workflow/api";
import type { Account } from "../accounts";
import { appDeps } from "./deps";
import { type Card, type Deps, type FileEvent, keys } from "./pipeline";
import { fileWorkflow } from "./workflow";

export type Signed = Account & { workspace: NonNullable<Account["workspace"]> };

export const MAX_SIZE = 50 * 1024 * 1024;
const URL_TTL = 15 * 60;

/** What a caller asks for: the steps the file needs beyond upload (none: only stored, like a logo) and the scopes it
 *  is found under in search. Categorize and index read extract's text, so asking for either asks for extract too. */
export type Need = { steps: readonly Step[]; scopes: string[] };
const withExtract = (steps: readonly Step[]): Step[] =>
  STEPS.filter((s) => steps.includes(s) || (s === "extract" && steps.length > 0));

export type FileInput = { name: string; mime: string; size: number };

// ---- for other services: by id, no access check ----

/** Step 1 of upload: the row (upload pending) and where the browser sends the bytes. uploadUrl null means the store
 *  has no direct upload (memory): PUT the bytes to /api/files/<id> instead. */
export async function createUpload(owner: { workspaceId: string; userId: string }, input: FileInput, need: Need) {
  if (input.size > MAX_SIZE) throw new Error(`file too large: ${input.size} bytes (max ${MAX_SIZE})`);
  const pending = Object.fromEntries(withExtract(need.steps).map((s) => [`${s}State`, "pending"]));
  const f = await createFile({
    workspaceId: owner.workspaceId,
    ownerId: owner.userId,
    name: input.name,
    mime: input.mime || "application/octet-stream",
    size: input.size,
    scopes: need.scopes,
    ...pending,
  });
  const uploadUrl = await appDeps().store.uploadUrl(keys.original(f.id), f.mime, URL_TTL);
  return { fileId: f.id, uploadUrl, headers: { "Content-Type": f.mime } };
}

/** Starts a workflow run for the file's pending steps and records it on the row (the events route reads its
 *  stream). Returns once the run is queued. */
export async function startProcessing(id: string) {
  const run = await start(fileWorkflow, [id]);
  await setRun(id, run.runId);
  return run.runId;
}

/** Runs the given steps again, or by default the ones trying again can fix: failed with a retryable error, and left
 *  pending or running by a run that stopped. A new text means new categories and chunks: redoing extract redoes
 *  everything after it (name extract to read a file again, e.g. once OCR is on for a no_text scan). While a run is
 *  busy with the file nothing is reset and no run started (a second "Try again"): the row as it is comes back, and
 *  the caller follows the run already working on it. */
export async function rerun(f: FileRow, steps?: Step[]) {
  if (f.uploadState !== "stored") return null;
  const redo = steps ?? STEPS.filter((s) => canRetry(f[`${s}State`], f[`${s}Error`]));
  if (!redo.length) return f;
  if (await resetSteps(f.id, redo.includes("extract") ? STEPS : redo)) await startProcessing(f.id);
  return fileById(f.id);
}

/** Why a delete did not happen: a run is still working on the file (wait for its steps to end, done or failed). */
export type Removed = "removed" | "busy";

/** Deletes a file everywhere, once no run is busy with it: the row is marked deleting (no run claims it again), then
 *  its vectors and its folder in the store go, then the row (links to it cascade). A delete that fails half way
 *  leaves the row deleting, hidden from lists; deleting it again finishes the job. */
export async function removeFile(id: string, d: Deps = appDeps()): Promise<Removed> {
  if (!(await markDeleting(id))) return "busy";
  await d.index.remove(id);
  await d.store.deletePrefix(keys.dir(id));
  await deleteFileRow(id);
  return "removed";
}

/** A file's row, its card's summary, a download link and its status. */
export async function fileView(f: FileRow) {
  const { store } = appDeps();
  const card = f.categorizeState === "done" ? await getJson<Card>(store, keys.card(f.id)) : null;
  return {
    file: f,
    summary: card?.summary ?? null,
    downloadUrl: f.uploadState === "stored" ? await store.downloadUrl(keys.original(f.id), URL_TTL, f.name) : null,
    status: fileStatus(f),
  };
}

// ---- status, live ----

/** A step and its state; `error` says what went wrong and whether trying again can help. */
export type StepStatus = { step: FileEvent["step"]; state: FileEvent["state"]; error: StepError | null };
/** How far a file is: every step it needs with its state, and when the row was last written (ms). Events older than
 *  `at` are already in it. */
export type FileStatus = { fileId: string; at: number; steps: StepStatus[]; finished: boolean };

const OPEN = new Set(["pending", "running"]);

/** Whether trying a step again can help: it failed with a retryable error, or a run stopped with it open. */
export const canRetry = (state: string | null, error: StepError | null) =>
  (state === "failed" && !!error?.retryable) || OPEN.has(state ?? "");

export function fileStatus(f: FileRow): FileStatus {
  const steps: StepStatus[] = [{ step: "upload", state: f.uploadState as StepStatus["state"], error: null }];
  for (const s of STEPS) {
    const state = f[`${s}State`];
    if (state != null) steps.push({ step: s, state: state as StepStatus["state"], error: f[`${s}Error`] });
  }
  // upload pending: the browser is still sending the bytes; no run yet
  const finished = f.uploadState === "failed" || (f.uploadState === "stored" && !steps.some((s) => OPEN.has(s.state)));
  return { fileId: f.id, at: f.updatedAt.getTime(), steps, finished };
}

/** The file's status as server-sent events: `snapshot` (the row now), then a `state` event per change the run
 *  writes (id = its index in the run's stream; a reconnect sends Last-Event-ID and resumes after it), then `end`
 *  when the run is over. A finished file gets its snapshot and `end` at once. */
export function fileEvents(f: FileRow, lastEventId?: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const sse = (event: string, data: unknown, id?: number) =>
    enc.encode(`${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const status = fileStatus(f);
  const live = !status.finished && f.uploadState === "stored" && f.runId;
  let reader: ReadableStreamDefaultReader<FileEvent> | null = null;
  let next = lastEventId != null && lastEventId >= 0 ? lastEventId + 1 : 0;

  return new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(sse("snapshot", status));
      if (!live) {
        c.enqueue(sse("end", { fileId: f.id }));
        c.close();
        return;
      }
      reader = getRun(f.runId!).getReadable<FileEvent>({ startIndex: next }).getReader();
    },
    async pull(c) {
      if (!reader) return;
      const { value, done } = await reader.read();
      if (done) {
        c.enqueue(sse("end", { fileId: f.id }));
        c.close();
        return;
      }
      c.enqueue(sse("state", value, next++));
    },
    async cancel() {
      await reader?.cancel();
    },
  });
}

// ---- a user's own files (the file router): owner only ----

/** The file, if it is this user's. Anything else reads as missing. */
async function own(a: Signed, id: string) {
  const f = await fileById(id);
  return f && f.workspaceId === a.workspace.id && f.ownerId === a.user.id ? f : null;
}

/** A private file: read and searchable by its owner only. */
export const startUpload = (a: Signed, input: FileInput) =>
  createUpload({ workspaceId: a.workspace.id, userId: a.user.id }, input, {
    steps: STEPS,
    scopes: [`user:${a.user.id}`],
  });

/** The bytes through the app, for a store without direct upload (and small files). Only while the upload is pending. */
export async function putUpload(a: Signed, id: string, bytes: Uint8Array) {
  const f = await own(a, id);
  if (!f || f.uploadState !== "pending") return false;
  if (bytes.byteLength > MAX_SIZE) throw new Error("file too large");
  await appDeps().store.put(keys.original(id), bytes, f.mime);
  return true;
}

/** Step 2 of upload, for every file whoever started it: the browser says the bytes are sent; checked in the store,
 *  then the steps the file needs start as a workflow run. The uploader is the owner. null when not this user's. */
export async function finishUpload(a: Signed, id: string) {
  const f = await own(a, id);
  if (!f) return null;
  if (f.uploadState !== "pending") return fileStatus(f); // stored already (a second call), failed, or deleting
  const d = appDeps();
  const head = await d.store.head(keys.original(id));
  if (!head) throw new Error("the file has not reached the store");
  if (head.size > MAX_SIZE) {
    await d.store.deletePrefix(keys.dir(id));
    await setUploaded(id, "failed", head.size);
    throw new Error("file too large");
  }
  // only the call that moves it pending -> stored starts the run: two finishUpload calls at once start one
  if ((await setUploaded(id, "stored", head.size)) && STEPS.some((s) => f[`${s}State`] === "pending"))
    await startProcessing(id);
  return fileStatus((await fileById(id))!);
}

export const listMyFiles = (a: Signed) => filesOfOwner(a.workspace.id, a.user.id);

export async function openFile(a: Signed, id: string) {
  const f = await own(a, id);
  return f ? fileView(f) : null;
}

/** The live status of the user's own file (the events route); null when it is not theirs. */
export async function myFileEvents(a: Signed, id: string, lastEventId?: number) {
  const f = await own(a, id);
  return f ? fileEvents(f, lastEventId) : null;
}

export async function reprocessFile(a: Signed, id: string, steps?: Step[]) {
  const f = await own(a, id);
  return f ? rerun(f, steps) : null;
}

/** null when the file is not this user's; "busy" while a run still works on it. */
export async function deleteFile(a: Signed, id: string): Promise<Removed | null> {
  return (await own(a, id)) ? removeFile(id) : null;
}

export { appDeps, appExtractors, dbRows } from "./deps";
export { isRetryable } from "./errors";
export {
  type Deps,
  type FileEvent,
  type FileRows,
  keys,
  noWriter,
  runFile,
  runStep,
  STEP_TIMEOUT,
  type StateWriter,
  StepTimeout,
} from "./pipeline";
export { fileWorkflow } from "./workflow";
