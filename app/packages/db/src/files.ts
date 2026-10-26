// Files and their processing state (schema.ts, files). Every step's state change is one UPDATE on the file's row;
// a step is claimed by moving it pending -> running in the same statement, so two runs never do the same step.
// Nothing here knows what a file is used for: who may find it is its `scopes`, set by the service that added it.
import { and, desc, eq, or, sql } from "drizzle-orm";
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
  categorize: { state: files.categorizeState, by: "categorizeBy", error: "categorizeError", stateKey: "categorizeState" },
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

export async function setUploaded(id: string, state: "stored" | "failed", size?: number) {
  await db
    .update(files)
    .set({ uploadState: state, ...(size != null && { size }), updatedAt: new Date() })
    .where(eq(files.id, id));
}

/** The workflow run now processing the file: the events route reads its stream. */
export const setRun = (id: string, runId: string) => db.update(files).set({ runId }).where(eq(files.id, id));

/** pending -> running; the row as claimed, or null when the step is not this run's to do. A step left running is
 *  claimed again by the run it belongs to (a retry: the attempt before it was cut off) or, past STALE, by any run. */
export async function claimStep(id: string, step: Step, runId?: string) {
  const c = col[step].state;
  const [row] = await db
    .update(files)
    .set({ [col[step].stateKey]: "running", updatedAt: new Date() })
    .where(
      and(
        eq(files.id, id),
        eq(files.uploadState, "stored"),
        or(
          eq(c, "pending"),
          and(eq(c, "running"), or(sql`${files.updatedAt} < now() - ${STALE}::interval`, runId ? eq(files.runId, runId) : undefined)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Ends a running step. Only a step still running is written: a reset (reprocess) or a newer claim in between wins.
 *  The time written (the row's updated_at), or null when nothing was. */
export async function endStep(id: string, step: Step, e: StepEnd) {
  const k = col[step];
  const at = new Date();
  const rows = await db
    .update(files)
    .set({ ...e.set, [k.stateKey]: e.state, [k.by]: e.by ?? null, [k.error]: e.error ?? null, updatedAt: at })
    .where(and(eq(files.id, id), eq(k.state, "running")))
    .returning({ id: files.id });
  return rows.length ? at : null;
}

/** Sets steps back to pending to run again (a retry, or a newer extractor); a step the file does not need stays null. */
export async function resetSteps(id: string, steps: readonly Step[]) {
  if (!steps.length) return;
  const set = Object.fromEntries(steps.map((s) => [col[s].stateKey, sql`case when ${col[s].state} is null then null else 'pending' end`]));
  await db.update(files).set({ ...set, updatedAt: new Date() }).where(eq(files.id, id));
}

export const filesOfOwner = (workspaceId: string, ownerId: string, limit = 100) =>
  db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.ownerId, ownerId)))
    .orderBy(desc(files.createdAt))
    .limit(limit);

export const deleteFileRow = (id: string) => db.delete(files).where(eq(files.id, id));

// Cases' files (case_files): the link only; the case service decides who may add or see them.

export async function caseById(id: string) {
  const [c] = await db.select().from(cases).where(eq(cases.id, id));
  return c ?? null;
}

export const linkCaseFile = (caseId: string, fileId: string, addedBy: string | null) =>
  db.insert(caseFiles).values({ caseId, fileId, addedBy });

export async function caseHasFile(caseId: string, fileId: string) {
  const [r] = await db.select({ id: caseFiles.fileId }).from(caseFiles).where(and(eq(caseFiles.caseId, caseId), eq(caseFiles.fileId, fileId)));
  return !!r;
}

export const filesOfCase = (caseId: string) =>
  db
    .select({ file: files })
    .from(caseFiles)
    .innerJoin(files, eq(files.id, caseFiles.fileId))
    .where(eq(caseFiles.caseId, caseId))
    .orderBy(desc(files.createdAt))
    .then((rs) => rs.map((r) => r.file));
