// Files and their processing state (schema.ts, files). Every step's state change is one UPDATE on the file's row;
// a step is claimed by moving it pending -> running in the same statement, so two runs never do the same step.
// Nothing here knows what a file is used for: who may find it is its `scopes`, set by the service that added it.
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { db } from "./client";
import { caseFiles, cases, files, type StepError } from "./schema";

export type { StepError };

export type FileRow = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export const STEPS = ["extract", "categorize", "index"] as const;
export type Step = (typeof STEPS)[number];
export type StepState = "pending" | "running" | "done" | "failed" | "no_text";
/** What a step writes when it ends: its state, what produced it, and the columns it fills. */
export type StepEnd = {
  state: Exclude<StepState, "running">; // pending: put back for a retry
  by?: string | null;
  error?: StepError | null;
  set?: Partial<Pick<FileRow, "sha256" | "pages" | "chunks" | "category" | "meta">>;
};

const STALE = "15 minutes"; // a step running longer was cut off (Vercel's limit is 5-15 min): any run may claim it

const col = {
  extract: { state: files.extractState, by: "extractBy", error: "extractError", stateKey: "extractState" },
  categorize: {
    state: files.categorizeState,
    by: "categorizeBy",
    error: "categorizeError",
    stateKey: "categorizeState",
  },
  index: { state: files.indexState, by: "indexBy", error: "indexError", stateKey: "indexState" },
} as const;

export async function createFile(f: NewFile) {
  const [row] = await db.insert(files).values(f).returning();
  return row!;
}

export async function fileById(id: string) {
  const [f] = await db.select().from(files).where(eq(files.id, id));
  return f ?? null;
}

/** pending -> stored | failed. Only while pending: a file being deleted stays deleting. */
export async function setUploaded(id: string, state: "stored" | "failed", size?: number) {
  const rows = await db
    .update(files)
    .set({ uploadState: state, ...(size != null && { size }), updatedAt: new Date() })
    .where(and(eq(files.id, id), eq(files.uploadState, "pending")))
    .returning({ id: files.id });
  return rows.length > 0;
}

/** Whether a run is working on the file, or is about to: a step running, extract pending, or categorize / index
 *  pending once extract is done (a step put back for the workflow's retry is pending too). Only within STALE of the
 *  row's last write: a run that stopped (crashed, cut off for good) does not hold the file forever. Pending steps
 *  after an extract that ended no_text or failed wait for nothing: not busy. Delete and reprocess wait while busy. */
// coalesce: a step the file does not need is null, and null = 'running' is null, not false
const idle = () => sql`not coalesce((${busy()}), false)`;
const busy = () =>
  and(
    eq(files.uploadState, "stored"),
    sql`${files.updatedAt} >= now() - ${STALE}::interval`,
    or(
      eq(files.extractState, "running"),
      eq(files.categorizeState, "running"),
      eq(files.indexState, "running"),
      eq(files.extractState, "pending"),
      and(eq(files.extractState, "done"), or(eq(files.categorizeState, "pending"), eq(files.indexState, "pending"))),
    ),
  );

/** The workflow run now processing the file: the events route reads its stream. */
export const setRun = (id: string, runId: string) => db.update(files).set({ runId }).where(eq(files.id, id));

/** pending -> running; the row as claimed, or null when the step is not this run's to do. A step left running is
 *  claimed again by the run it belongs to (a retry: the attempt before it was cut off) or, past STALE, by any run. */
export async function claimStep(id: string, step: Step, runId?: string) {
  const c = col[step].state;
  const [row] = await db
    .update(files)
    // the claiming run owns the file's steps from here: only it may end them (endStep)
    .set({ [col[step].stateKey]: "running", ...(runId && { runId }), updatedAt: new Date() })
    .where(
      and(
        eq(files.id, id),
        eq(files.uploadState, "stored"),
        or(
          eq(c, "pending"),
          and(
            eq(c, "running"),
            or(sql`${files.updatedAt} < now() - ${STALE}::interval`, runId ? eq(files.runId, runId) : undefined),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Ends a running step. Only a step still running, and with `runId` only one this run still owns, is written: a
 *  reset (reprocess) or another run's claim in between wins. The time written (the row's updated_at), or null when
 *  nothing was. */
export async function endStep(id: string, step: Step, e: StepEnd, runId?: string) {
  const k = col[step];
  const at = new Date();
  const rows = await db
    .update(files)
    .set({ ...e.set, [k.stateKey]: e.state, [k.by]: e.by ?? null, [k.error]: e.error ?? null, updatedAt: at })
    .where(and(eq(files.id, id), eq(k.state, "running"), runId ? eq(files.runId, runId) : undefined))
    .returning({ id: files.id });
  return rows.length ? at : null;
}

/** Sets steps back to pending to run again (a retry, or a newer extractor); a step the file does not need stays null.
 *  Not while a run is busy with the file (a second "Try again" while the first one's run works): false then. */
export async function resetSteps(id: string, steps: readonly Step[]) {
  if (!steps.length) return true;
  const set = Object.fromEntries(
    steps.map((s) => [col[s].stateKey, sql`case when ${col[s].state} is null then null else 'pending' end`]),
  );
  const rows = await db
    .update(files)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(files.id, id), eq(files.uploadState, "stored"), idle()))
    .returning({ id: files.id });
  return rows.length > 0;
}

export const filesOfOwner = (workspaceId: string, ownerId: string, limit = 100) =>
  db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.ownerId, ownerId), ne(files.uploadState, "deleting")))
    .orderBy(desc(files.createdAt))
    .limit(limit);

/** Step 1 of a delete: the row says deleting, so no run claims a step of it again (claimStep needs stored) and lists
 *  leave it out. Refused (false) while a run is busy with the file; a file already deleting may be deleted again (a
 *  delete that failed half way). */
export async function markDeleting(id: string) {
  const rows = await db
    .update(files)
    .set({ uploadState: "deleting", updatedAt: new Date() })
    .where(and(eq(files.id, id), idle()))
    .returning({ id: files.id });
  return rows.length > 0;
}

/** The last step of a delete, once its vectors and blobs are gone. */
export const deleteFileRow = (id: string) =>
  db.delete(files).where(and(eq(files.id, id), eq(files.uploadState, "deleting")));

// Cases' files (case_files): the link only; the case service decides who may add or see them.

export async function caseById(id: string) {
  const [c] = await db.select().from(cases).where(eq(cases.id, id));
  return c ?? null;
}

export const linkCaseFile = (caseId: string, fileId: string, addedBy: string | null) =>
  db.insert(caseFiles).values({ caseId, fileId, addedBy });

export async function caseHasFile(caseId: string, fileId: string) {
  const [r] = await db
    .select({ id: caseFiles.fileId })
    .from(caseFiles)
    .where(and(eq(caseFiles.caseId, caseId), eq(caseFiles.fileId, fileId)));
  return !!r;
}

export const filesOfCase = (caseId: string) =>
  db
    .select({ file: files })
    .from(caseFiles)
    .innerJoin(files, eq(files.id, caseFiles.fileId))
    .where(and(eq(caseFiles.caseId, caseId), ne(files.uploadState, "deleting")))
    .orderBy(desc(files.createdAt))
    .then((rs) => rs.map((r) => r.file));

/** How many of the case's files a run is busy with: a case is deleted only when none is. */
export async function busyFilesOfCase(caseId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(caseFiles)
    .innerJoin(files, eq(files.id, caseFiles.fileId))
    .where(and(eq(caseFiles.caseId, caseId), busy()));
  return r?.n ?? 0;
}
