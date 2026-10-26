// Cases. For now only a case's files: who may add and see them is decided here, the file itself is the file
// service's (./files): a case file is a generic file asked for every step, found under the case's scope.

import type { Step } from "@sllaw/db";
import { caseById, caseHasFile, fileById, filesOfCase, linkCaseFile, STEPS } from "@sllaw/db";
import {
  createUpload,
  type FileInput,
  fileStatus,
  fileView,
  type Removed,
  removeFile,
  rerun,
  type Signed,
} from "./files";

/** ponytail: only the case's author may see and change its files until case_shares exists (docs/APP.md, Access:
 *  viewer reads, editor adds/removes). Then this becomes the caseViewer / caseEditor check. */
async function caseOf(a: Signed, caseId: string) {
  const c = await caseById(caseId);
  return c && c.workspaceId === a.workspace.id && c.createdBy === a.user.id ? c : null;
}

/** A file of this case, if the user can see the case. */
async function caseFile(a: Signed, caseId: string, fileId: string) {
  if (!(await caseOf(a, caseId)) || !(await caseHasFile(caseId, fileId))) return null;
  return fileById(fileId);
}

const scope = (caseId: string) => `case:${caseId}`;

/** Adds a file to a case: read, categorized and indexed, found by everyone who can see the case. Returns where the
 *  browser sends the bytes; file.finishUpload then starts the processing, as for any file. */
export async function addCaseFile(a: Signed, caseId: string, input: FileInput) {
  if (!(await caseOf(a, caseId))) return null;
  const up = await createUpload({ workspaceId: a.workspace.id, userId: a.user.id }, input, {
    steps: STEPS,
    scopes: [scope(caseId)],
  });
  try {
    await linkCaseFile(caseId, up.fileId, a.user.id);
  } catch (e) {
    await removeFile(up.fileId);
    throw e;
  }
  return up;
}

export async function listCaseFiles(a: Signed, caseId: string) {
  return (await caseOf(a, caseId)) ? (await filesOfCase(caseId)).map((f) => ({ ...f, status: fileStatus(f) })) : null;
}

export async function openCaseFile(a: Signed, caseId: string, fileId: string) {
  const f = await caseFile(a, caseId, fileId);
  return f ? fileView(f) : null;
}

export async function reprocessCaseFile(a: Signed, caseId: string, fileId: string, steps?: Step[]) {
  const f = await caseFile(a, caseId, fileId);
  return f ? rerun(f, steps) : null;
}

/** Removes a file from the case, and so everywhere: a case file has no use outside its case. null when the user
 *  cannot see it; "busy" while a run still works on it. */
export async function removeCaseFile(a: Signed, caseId: string, fileId: string): Promise<Removed | null> {
  return (await caseFile(a, caseId, fileId)) ? removeFile(fileId) : null;
}
