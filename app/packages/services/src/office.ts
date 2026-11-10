// The case office (docs/APP.md, Case office): a case's header, people, court dates, tasks and dashboard, changed by the
// lawyer's page and by the agent through the same operations (@sllaw/office). Every change is recorded with what it
// touched, so any one can be undone. Who may see and change it: the case's (caseOf).
import { changeOf, changesOf, diaryOf, officeOf, saveOffice } from "@sllaw/db";
import {
  addDays,
  apply,
  describe,
  diff,
  emptyOffice,
  type Office,
  OfficeError,
  type Op,
  officeSchema,
  restore,
  today,
} from "@sllaw/office";
import { caseOf } from "./cases";
import type { Signed } from "./files";

export { OfficeError };

const TRIES = 3; // another write between our read and our write: read again and redo the change

/** The case's office (the empty one before its first change) and its version. Access already checked. */
export async function readOffice(caseId: string): Promise<{ office: Office; version: number }> {
  const r = await officeOf(caseId);
  if (!r) return { office: emptyOffice(), version: 0 };
  // a stored office that no longer passes the schema (an older shape) is read as far as it goes
  const ok = officeSchema.safeParse(r.doc);
  return { office: ok.success ? ok.data : { ...emptyOffice(), ...r.doc }, version: r.version };
}

export type ChangeMeta = { by: "lawyer" | "ai"; userId: string; chatId?: string | null; summary?: string | null };
export type Changed = { office: Office; version: number; changeId: string; summary: string };

/** Applies the operations as `by` and records the change. Access already checked. Throws OfficeError when the change
 *  cannot be made (nothing written). */
export async function writeOffice(caseId: string, ops: Op[], meta: ChangeMeta): Promise<Changed> {
  for (let i = 0; i < TRIES; i++) {
    const { office, version } = await readOffice(caseId);
    const next = apply(office, ops, meta.by);
    const summary = meta.summary?.trim() || describe(ops, office);
    if (!next.items.length) return { office, version, changeId: "", summary: "Nothing changed" };
    const changeId = await saveOffice(caseId, version, next.office, {
      by: meta.by,
      userId: meta.userId,
      chatId: meta.chatId,
      summary,
      items: next.items,
    });
    if (changeId) return { office: next.office, version: version + 1, changeId, summary };
  }
  throw new OfficeError("The case was being changed at the same time: try again.");
}

// ---- for the lawyer (api) ----

export async function openOffice(a: Signed, caseId: string) {
  if (!(await caseOf(a, caseId))) return null;
  return { ...(await readOffice(caseId)), today: today() };
}

export async function changeOffice(a: Signed, caseId: string, ops: Op[]) {
  if (!(await caseOf(a, caseId))) return null;
  return writeOffice(caseId, ops, { by: "lawyer", userId: a.user.id });
}

export async function officeHistory(a: Signed, caseId: string) {
  if (!(await caseOf(a, caseId))) return null;
  return changesOf(caseId);
}

/** Undoes one change: puts back what it touched as it was before it, keeping what changed since elsewhere. The undo is
 *  a change of its own (in the history, undoable). "done" when it was already undone. */
export async function undoChange(a: Signed, caseId: string, changeId: string) {
  if (!(await caseOf(a, caseId))) return null;
  for (let i = 0; i < TRIES; i++) {
    // read again each try: another undo of the same change may have won (the write refuses a second)
    const c = await changeOf(caseId, changeId);
    if (!c) return null;
    if (c.undoneBy) return "done" as const;
    const { office, version } = await readOffice(caseId);
    const back = restore(office, c.items);
    const items = diff(office, back);
    const id = await saveOffice(caseId, version, back, {
      by: "lawyer",
      userId: a.user.id,
      summary: `Undid: ${c.summary}`,
      items,
      undoes: c.id,
    });
    if (id) return { office: back, version: version + 1, changeId: id };
  }
  throw new OfficeError("The case was being changed at the same time: try again.");
}

export const DIARY_DAYS = 7; // Home: today and the next 7 days

/** Home's diary: the user's court dates today and in the next week, past dates still waiting for an outcome, and
 *  open tasks due by then (overdue included), across their cases. */
export async function diary(a: Signed) {
  const day = today();
  const to = addDays(day, DIARY_DAYS);
  return { today: day, to, ...(await diaryOf(a.workspace.id, a.user.id, day, to)) };
}
