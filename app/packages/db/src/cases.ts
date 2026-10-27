// Cases: the rows only; who may see or change one is the case service's (services/src/cases.ts).
import { and, count, desc, eq, max, ne, sql } from "drizzle-orm";
import { db } from "./client";
import { caseFiles, cases, chats, files } from "./schema";

export type CaseRow = typeof cases.$inferSelect;

export async function insertCase(c: { workspaceId: string; createdBy: string; title: string; facts: string }) {
  const [row] = await db.insert(cases).values(c).returning();
  return row!;
}

/** A user's cases in a workspace, last worked on first (created, a file added, or their own chat in it touched): the
 *  start of the facts, how many files, when the last was added. */
export function casesOf(workspaceId: string, userId: string) {
  const lastChat = sql<Date | null>`(select max(${chats.updatedAt}) from ${chats}
    where ${chats.caseId} = ${cases.id} and ${chats.userId} = ${userId})`;
  const lastActivity = sql`greatest(${cases.createdAt}, max(${files.createdAt}), ${lastChat})`;
  return db
    .select({
      id: cases.id,
      title: cases.title,
      facts: sql<string>`left(${cases.facts}, 280)`,
      createdAt: cases.createdAt,
      files: count(files.id),
      lastFileAt: max(files.createdAt),
      // as epoch ms: the raw timestamp text of an expression is not one Date parses
      lastActivity: sql`extract(epoch from ${lastActivity}) * 1000`.mapWith((v) => new Date(Number(v))),
    })
    .from(cases)
    .leftJoin(caseFiles, eq(caseFiles.caseId, cases.id))
    .leftJoin(files, and(eq(files.id, caseFiles.fileId), ne(files.uploadState, "deleting")))
    .where(and(eq(cases.workspaceId, workspaceId), eq(cases.createdBy, userId)))
    .groupBy(cases.id)
    .orderBy(desc(lastActivity));
}

export const setCase = (id: string, c: { title: string; facts: string }) =>
  db.update(cases).set(c).where(eq(cases.id, id));

/** The row only: its files must be removed first (vectors and blobs); case_files and chats cascade. */
export const deleteCaseRow = (id: string) => db.delete(cases).where(eq(cases.id, id));
