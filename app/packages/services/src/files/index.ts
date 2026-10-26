// Files for the api: upload, list, read, retry, delete, search. Access (docs/APP.md, Access) is checked here, before
// any row or blob is touched. The pipelines themselves are in ./pipeline and know nothing of users.
import {
  caseById,
  casesOfFile,
  createFile,
  deleteFileRow,
  type FileRow,
  fileById,
  fileIdsByCategory,
  filesOfCase,
  filesOfOwner,
  resetSteps,
  STEPS,
  type Step,
  setUploaded,
} from "@sllaw/db";
import { getJson } from "@sllaw/storage";
import { start } from "workflow/api";
import type { Account } from "../accounts";
import { appDeps } from "./deps";
import { type Card, type Deps, keys } from "./pipeline";
import { fileWorkflow } from "./workflow";

type Signed = Account & { workspace: NonNullable<Account["workspace"]> };

/** Starts a file's pipelines as a workflow run (durable, retried steps). Returns once the run is queued. */
const startPipelines = (id: string) => start(fileWorkflow, [id]);

/** What a file is for decides which steps it needs: a case file or a private one is read and searchable; an asset
 *  (a logo, an image in a document) is only stored. */
export type Use = "case" | "private" | "asset";
const STEPS_OF: Record<Use, Step[]> = { case: [...STEPS], private: [...STEPS], asset: [] };

export const MAX_SIZE = 50 * 1024 * 1024;
const URL_TTL = 15 * 60;

/** ponytail: only the case's author may see and change its files until case_shares exists (docs/APP.md, Access:
 *  viewer reads, editor adds/removes). Then this becomes the caseViewer / caseEditor check. */
async function caseOf(a: Signed, caseId: string) {
  const c = await caseById(caseId);
  return c && c.workspaceId === a.workspace.id && c.createdBy === a.user.id ? c : null;
}

/** The file, if this user may see it: their own, or in a case they can see. Anything else reads as missing. */
async function fileOf(a: Signed, id: string) {
  const f = await fileById(id);
  if (!f || f.workspaceId !== a.workspace.id) return null;
  if (f.ownerId === a.user.id) return f;
  for (const c of await casesOfFile(id)) if (await caseOf(a, c)) return f;
  return null;
}

/** Step 1 of upload: the row (upload pending) and where the browser sends the bytes. uploadUrl null means the store
 *  has no direct upload (memory): PUT the bytes to /api/files/<id> instead. */
export async function startUpload(
  a: Signed,
  input: { name: string; mime: string; size: number; use: Use; caseId?: string },
) {
  if (input.size > MAX_SIZE) throw new Error(`file too large: ${input.size} bytes (max ${MAX_SIZE})`);
  if (input.use === "case" && !(input.caseId && (await caseOf(a, input.caseId)))) return null;
  const pending = Object.fromEntries(STEPS_OF[input.use].map((s) => [`${s}State`, "pending"]));
  const f = await createFile(
    {
      workspaceId: a.workspace.id,
      ownerId: a.user.id,
      name: input.name,
      mime: input.mime || "application/octet-stream",
      size: input.size,
      ...pending,
    },
    input.use === "case" ? input.caseId : null,
    a.user.id,
  );
  const { store } = appDeps();
  const uploadUrl = await store.uploadUrl(keys.original(f.id), f.mime, URL_TTL);
  return { fileId: f.id, uploadUrl, headers: { "Content-Type": f.mime } };
}

/** The bytes through the app, for a store without direct upload (and small files). Only while the upload is pending. */
export async function putUpload(a: Signed, id: string, bytes: Uint8Array) {
  const f = await fileById(id);
  if (!f || f.workspaceId !== a.workspace.id || f.ownerId !== a.user.id || f.uploadState !== "pending") return false;
  if (bytes.byteLength > MAX_SIZE) throw new Error("file too large");
  await appDeps().store.put(keys.original(id), bytes, f.mime);
  return true;
}

/** Step 2 of upload: the browser says the bytes are sent; checked in the store, then the pipelines start as a
 *  workflow run. null when the file is not this user's. */
export async function finishUpload(a: Signed, id: string) {
  const f = await fileById(id);
  if (!f || f.workspaceId !== a.workspace.id || f.ownerId !== a.user.id) return null;
  if (f.uploadState === "stored") return f;
  const d = appDeps();
  const head = await d.store.head(keys.original(id));
  if (!head) throw new Error("the file has not reached the store");
  if (head.size > MAX_SIZE) {
    await d.store.deletePrefix(keys.dir(id));
    await setUploaded(id, "failed", head.size);
    throw new Error("file too large");
  }
  await setUploaded(id, "stored", head.size);
  await startPipelines(id);
  return fileById(id);
}

export async function listCaseFiles(a: Signed, caseId: string) {
  return (await caseOf(a, caseId)) ? filesOfCase(caseId) : null;
}

export const listMyFiles = (a: Signed) => filesOfOwner(a.workspace.id, a.user.id);

/** A file's row, its card's summary and a download link. */
export async function openFile(a: Signed, id: string) {
  const f = await fileOf(a, id);
  if (!f) return null;
  const { store } = appDeps();
  const card = f.categorizeState === "done" ? await getJson<Card>(store, keys.card(id)) : null;
  return {
    file: f,
    summary: card?.summary ?? null,
    downloadUrl: f.uploadState === "stored" ? await store.downloadUrl(keys.original(id), URL_TTL, f.name) : null,
    progress: progress(f),
  };
}

/** How far a file is, for the UI: every step it needs with its state. */
export const progress = (f: FileRow) =>
  [{ step: "upload", state: f.uploadState, error: null as string | null }].concat(
    STEPS.filter((s) => f[`${s}State`] != null).map((s) => ({
      step: s,
      state: f[`${s}State`]!,
      error: f[`${s}Error`],
    })),
  );

/** Runs the failed (or all, with `steps`) steps of a file again. */
export async function reprocessFile(a: Signed, id: string, steps?: Step[]) {
  const f = await fileOf(a, id);
  if (!f || f.uploadState !== "stored") return null;
  const redo = steps ?? STEPS.filter((s) => f[`${s}State`] === "failed" || f[`${s}State`] === "no_text");
  // a new text means new categories and chunks: everything after extract runs again
  await resetSteps(id, redo.includes("extract") ? STEPS : redo);
  await startPipelines(id);
  return fileById(id);
}

/** Deletes a file everywhere: its vectors, its folder in the store, then its row (case links cascade). */
export async function deleteFile(a: Signed, id: string, d: Deps = appDeps()) {
  const f = await fileOf(a, id);
  if (!f) return false;
  await removeFile(id, d);
  return true;
}

export async function removeFile(id: string, d: Deps = appDeps()) {
  await d.index.remove(id);
  await d.store.deletePrefix(keys.dir(id));
  await deleteFileRow(id);
}

/** Search the files this request may see: a case's (when the user can see the case) or the user's own. A doc_type
 *  filter becomes the ids of the files in those categories (the vectors carry no type). */
export async function searchFiles(
  a: Signed,
  query: string,
  opts: { caseId?: string; docTypes?: string[]; limit?: number } = {},
) {
  if (opts.caseId && !(await caseOf(a, opts.caseId))) return [];
  const scopes = opts.caseId ? [`case:${opts.caseId}`] : [`user:${a.user.id}`];
  const fileIds = opts.docTypes?.length
    ? await fileIdsByCategory({
        workspaceId: a.workspace.id,
        caseId: opts.caseId,
        ownerId: a.user.id,
        categories: opts.docTypes,
      })
    : undefined;
  return appDeps().index.search(query, { workspaceId: a.workspace.id, scopes, fileIds, limit: opts.limit });
}

export { appDeps, dbRows } from "./deps";
export { type Deps, type FileRows, keys, runFile, runStep } from "./pipeline";
export { fileWorkflow } from "./workflow";
