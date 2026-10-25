// Files and their processing state (schema.ts, files). Every step's state change is one UPDATE on the file's row;
// a step is claimed by moving it pending -> running in the same statement, so two runs never do the same step.
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "./client";
import { caseFiles, cases, files } from "./schema";

export type FileRow = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export const STEPS = ["extract", "categorize", "index"] as const;
export type Step = (typeof STEPS)[number];
export type StepState = "pending" | "running" | "done" | "failed" | "no_text";
/** What a step writes when it ends: its state, what produced it, and the columns it fills. */
export type StepEnd = {
  state: Exclude<StepState, "running">; // pending: put back for a retry
  by?: string | null;
  error?: string | null;
  set?: Partial<Pick<FileRow, "sha256" | "pages" | "chunks" | "category" | "meta">>;
};

const STALE = "15 minutes"; // a step running longer was cut off (Vercel's limit is 5-15 min): it may be claimed again

const col = {
  extract: { state: files.extractState, by: "extractBy", error: "extractError", stateKey: "extractState" },
  categorize: { state: files.categorizeState, by: "categorizeBy", error: "categorizeError", stateKey: "categorizeState" },
  index: { state: files.indexState, by: "indexBy", error: "indexError", stateKey: "indexState" },
} as const;

export async function createFile(f: NewFile, caseId?: string | null, addedBy?: string | null) {
  const [row] = await db.insert(files).values(f).returning();
  if (caseId) await db.insert(caseFiles).values({ caseId, fileId: row!.id, addedBy });
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

/** pending (or a stale running) -> running; the row as claimed, or null when the step is not this run's to do. */
export async function claimStep(id: string, step: Step) {
  const c = col[step].state;
  const [row] = await db
    .update(files)
    .set({ [col[step].stateKey]: "running", updatedAt: new Date() })
    .where(
      and(
        eq(files.id, id),
        eq(files.uploadState, "stored"),
        or(eq(c, "pending"), and(eq(c, "running"), sql`${files.updatedAt} < now() - ${STALE}::interval`)),
      ),
    )
    .returning();
  return row ?? null;
}

export async function endStep(id: string, step: Step, e: StepEnd) {
  const k = col[step];
  await db
    .update(files)
    .set({ ...e.set, [k.stateKey]: e.state, [k.by]: e.by ?? null, [k.error]: e.error ?? null, updatedAt: new Date() })
    .where(eq(files.id, id));
}

/** Sets steps back to pending to run again (a retry, or a newer extractor); a step the file does not need stays null. */
export async function resetSteps(id: string, steps: readonly Step[]) {
  const set = Object.fromEntries(steps.map((s) => [col[s].stateKey, sql`case when ${col[s].state} is null then null else 'pending' end`]));
  await db.update(files).set({ ...set, updatedAt: new Date() }).where(eq(files.id, id));
}

/** Files a step is done for, with what did it; with `notBy`, only those done by something else: what a new
 *  categorizer or index re-runs. */
export const filesDone = (step: Step, notBy?: string, limit = 1000) =>
  db
    .select({ id: files.id, mime: files.mime, name: files.name, by: files[col[step].by] })
    .from(files)
    .where(
      and(
        eq(col[step].state, "done"),
        notBy ? or(sql`${files[col[step].by]} is null`, ne(files[col[step].by], notBy)) : undefined,
      ),
    )
    .limit(limit);

/** The scopes a file is shared under (docs/APP.md, User files): case:<id> for each case it is in, else user:<owner>. */
export async function scopesOfFile(f: Pick<FileRow, "id" | "ownerId">) {
  const cs = await db.select({ caseId: caseFiles.caseId }).from(caseFiles).where(eq(caseFiles.fileId, f.id));
  if (cs.length) return cs.map((c) => `case:${c.caseId}`);
  return f.ownerId ? [`user:${f.ownerId}`] : [];
}

export const casesOfFile = async (fileId: string) =>
  (await db.select({ caseId: caseFiles.caseId }).from(caseFiles).where(eq(caseFiles.fileId, fileId))).map((c) => c.caseId);

export const filesOfCase = (caseId: string) =>
  db
    .select({ file: files })
    .from(caseFiles)
    .innerJoin(files, eq(files.id, caseFiles.fileId))
    .where(eq(caseFiles.caseId, caseId))
    .orderBy(desc(files.createdAt))
    .then((rs) => rs.map((r) => r.file));

export const filesOfOwner = (workspaceId: string, ownerId: string, limit = 100) =>
  db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.ownerId, ownerId)))
    .orderBy(desc(files.createdAt))
    .limit(limit);

export const deleteFileRow = (id: string) => db.delete(files).where(eq(files.id, id));

export async function caseById(id: string) {
  const [c] = await db.select().from(cases).where(eq(cases.id, id));
  return c ?? null;
}

/** Files left running past STALE or pending after upload: what a sweep (cron) picks up again. */
export const unfinishedFiles = (limit = 100) =>
  db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.uploadState, "stored"),
        or(...STEPS.map((s) => inArray(col[s].state, ["pending", "running"]))),
        sql`${files.updatedAt} < now() - ${STALE}::interval`,
      ),
    )
    .limit(limit);


/** Ids of a case's files (or an owner's private files) in these categories: a search filter by doc_type. */
export async function fileIdsByCategory(q: { workspaceId: string; caseId?: string; ownerId?: string; categories: string[] }) {
  const where = and(eq(files.workspaceId, q.workspaceId), inArray(files.category, q.categories));
  const rows = q.caseId
    ? await db.select({ id: files.id }).from(caseFiles).innerJoin(files, eq(files.id, caseFiles.fileId)).where(and(where, eq(caseFiles.caseId, q.caseId)))
    : await db.select({ id: files.id }).from(files).where(and(where, eq(files.ownerId, q.ownerId!)));
  return rows.map((r) => r.id);
}
