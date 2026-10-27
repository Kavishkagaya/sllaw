// Cases: the case itself (create, list, open, edit, delete) and its files. Who may see and change a case is decided
// here; a case file is the file service's (./files): a generic file asked for every step, found under the case's scope.

import type { DocType } from "@sllaw/ai";
import type { FileRow, Step } from "@sllaw/db";
import {
  busyFilesOfCase,
  caseById,
  caseHasFile,
  casesOf,
  deleteCaseRow,
  fileById,
  filesOfCase,
  insertCase,
  linkCaseFile,
  STEPS,
  setCase,
} from "@sllaw/db";
import {
  createUpload,
  type FileInput,
  type FileStatus,
  fileStatus,
  fileView,
  type Removed,
  removeFile,
  rerun,
  type Signed,
} from "./files";

/** The case if this user may see and change it, else null. ponytail: only the case's author may until case_shares
 *  exists (docs/APP.md, Access: viewer reads, editor adds/removes). Then this becomes the caseViewer / caseEditor
 *  check. */
export async function caseOf(a: Signed, caseId: string) {
  const c = await caseById(caseId);
  return c && c.workspaceId === a.workspace.id && c.createdBy === a.user.id ? c : null;
}

/** A file of this case, if the user can see the case. */
async function caseFile(a: Signed, caseId: string, fileId: string) {
  if (!(await caseOf(a, caseId)) || !(await caseHasFile(caseId, fileId))) return null;
  return fileById(fileId);
}

const scope = (caseId: string) => `case:${caseId}`;

// ---- the case ----

export type CaseInput = { title: string; facts: string };

export const createCase = (a: Signed, input: CaseInput) =>
  insertCase({ workspaceId: a.workspace.id, createdBy: a.user.id, ...input });

export const listCases = (a: Signed) => casesOf(a.workspace.id, a.user.id);

export async function openCase(a: Signed, caseId: string) {
  const c = await caseOf(a, caseId);
  return c && { id: c.id, title: c.title, facts: c.facts, createdAt: c.createdAt };
}

export async function updateCase(a: Signed, caseId: string, input: CaseInput) {
  if (!(await caseOf(a, caseId))) return null;
  await setCase(caseId, input);
  return { id: caseId };
}

/** Deletes the case with its files (vectors and blobs too) and its chats. Refused ("busy") while a run is working
 *  on any of its files, so nothing is half deleted; a file that turns busy in between stops it with the case kept. */
export async function deleteCase(a: Signed, caseId: string): Promise<Removed | null> {
  if (!(await caseOf(a, caseId))) return null;
  if (await busyFilesOfCase(caseId)) return "busy";
  for (const f of await filesOfCase(caseId)) if ((await removeFile(f.id)) === "busy") return "busy";
  await deleteCaseRow(caseId);
  return "removed";
}

// ---- its files ----

/** How a case's files are grouped in the UI, by the category (doc type) the categorizer gave them. Every doc type
 *  has a group (a new one fails the type check until it is placed); the order here is the order shown. */
const GROUPS = [
  "Pleadings",
  "Affidavits and statements",
  "Judgments and orders",
  "Charges and police",
  "Evidence and reports",
  "Contracts and deeds",
  "Correspondence",
  "Records and certificates",
  "Law",
  "Notes and other",
] as const;
type Group = (typeof GROUPS)[number];

const GROUP_OF: Record<DocType, Group> = {
  plaint: "Pleadings",
  answer: "Pleadings",
  replication: "Pleadings",
  petition: "Pleadings",
  objections: "Pleadings",
  motion: "Pleadings",
  written_submissions: "Pleadings",
  appeal: "Pleadings",
  affidavit: "Affidavits and statements",
  counter_affidavit: "Affidavits and statements",
  statement: "Affidavits and statements",
  judgment: "Judgments and orders",
  order: "Judgments and orders",
  decree: "Judgments and orders",
  journal_entry: "Judgments and orders",
  indictment: "Charges and police",
  charge_sheet: "Charges and police",
  police_report: "Charges and police",
  evidence: "Evidence and reports",
  expert_report: "Evidence and reports",
  medical_report: "Evidence and reports",
  contract: "Contracts and deeds",
  agreement: "Contracts and deeds",
  lease: "Contracts and deeds",
  deed: "Contracts and deeds",
  will: "Contracts and deeds",
  power_of_attorney: "Contracts and deeds",
  letter: "Correspondence",
  notice: "Correspondence",
  letter_of_demand: "Correspondence",
  email: "Correspondence",
  invoice: "Records and certificates",
  receipt: "Records and certificates",
  identity_document: "Records and certificates",
  certificate: "Records and certificates",
  form: "Records and certificates",
  gazette: "Law",
  legislation: "Law",
  notes: "Notes and other",
  other: "Notes and other",
};

const PROCESSING = "Processing";
const UNSORTED = "Not categorized";
const ORDER = [PROCESSING, ...GROUPS, UNSORTED];

/** A file's group: by its category once it has one; before that, still processing, or never categorized (finished,
 *  or a step failed: after a failed extract, categorize and index stay pending and the file is never finished). */
function groupOf(f: FileRow, status: FileStatus): string {
  const g = f.category ? GROUP_OF[f.category as DocType] : undefined;
  if (g) return g;
  const stuck = status.steps.some((s) => s.state === "failed" || s.state === "no_text");
  return status.finished || stuck ? UNSORTED : PROCESSING;
}

/** The case's files with their status and group, in group order (newest first within a group). */
export async function listCaseFiles(a: Signed, caseId: string) {
  if (!(await caseOf(a, caseId))) return null;
  const rows = (await filesOfCase(caseId)).map((f) => {
    const status = fileStatus(f);
    return { ...f, status, group: groupOf(f, status) };
  });
  // a stable sort keeps the query's newest-first order inside each group
  return rows.sort((x, y) => ORDER.indexOf(x.group) - ORDER.indexOf(y.group));
}

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
