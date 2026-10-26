// Cases: the rows only; who may see or change one is the case service's (services/src/cases.ts).
import { and, count, desc, eq, max, ne, sql } from "drizzle-orm";
import { db } from "./client";
import { caseFiles, cases, files } from "./schema";

export type CaseRow = typeof cases.$inferSelect;

export async function insertCase(c: { workspaceId: string; createdBy: string; title: string; facts: string }) {
  const [row] = await db.insert(cases).values(c).returning();
  return row!;
}

/** A user's cases in a workspace, newest first: the start of the facts, how many files, when the last was added. */
export const casesOf = (workspaceId: string, userId: string) =>
  db
    .select({
      id: cases.id,
      title: cases.title,
      facts: sql<string>`left(${cases.facts}, 280)`,
      createdAt: cases.createdAt,
      files: count(files.id),
      lastFileAt: max(files.createdAt),
    })
    .from(cases)
    .leftJoin(caseFiles, eq(caseFiles.caseId, cases.id))
    .leftJoin(files, and(eq(files.id, caseFiles.fileId), ne(files.uploadState, "deleting")))
    .where(and(eq(cases.workspaceId, workspaceId), eq(cases.createdBy, userId)))
    .groupBy(cases.id)
    .orderBy(desc(cases.createdAt));

export const setCase = (id: string, c: { title: string; facts: string }) =>
  db.update(cases).set(c).where(eq(cases.id, id));

/** The row only: its files must be removed first (vectors and blobs); case_files and chats cascade. */
export const deleteCaseRow = (id: string) => db.delete(cases).where(eq(cases.id, id));
