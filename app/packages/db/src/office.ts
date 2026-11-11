// Case offices (schema: case_offices). Who may read or change one is the case
// service's; what a valid office is, @sllaw/office's.
import type { Office } from "@sllaw/office";
import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { caseOffices } from "./schema";

/** The stored office and its version; null when the case has none yet (it then has the empty office, version 0). */
export async function officeOf(caseId: string) {
  const [r] = await db
    .select({ doc: caseOffices.doc, version: caseOffices.version })
    .from(caseOffices)
    .where(eq(caseOffices.caseId, caseId));
  return r ?? null;
}

/** Writes the office if it is still at `version` (one statement: the HTTP driver has no transactions). False when
 *  someone else wrote first (the caller reads again and retries). */
export async function saveOffice(caseId: string, version: number, doc: Office): Promise<boolean> {
  const json = JSON.stringify(doc);
  const r =
    version === 0
      ? await db.execute(sql`insert into ${caseOffices} (case_id, doc, version) values (${caseId}, ${json}::jsonb, 1)
          on conflict (case_id) do nothing returning case_id`)
      : await db.execute(sql`update ${caseOffices} set doc = ${json}::jsonb, version = version + 1, updated_at = now()
          where case_id = ${caseId} and version = ${version} returning case_id`);
  return r.rows.length > 0;
}

export type DiaryDate = {
  caseId: string;
  title: string;
  caseNumber: string;
  id: string;
  date: string;
  court: string;
  purpose: string;
};
export type DiaryTask = { caseId: string; title: string; caseNumber: string; id: string; task: string; due: string };

/** A user's diary across their cases in a workspace: court dates from `from` to `to` (YYYY-MM-DD, both in), dates
 *  before `from` still waiting for an outcome, and open tasks due by `to` (overdue ones included). The dates are read
 *  inside the database: only these small rows leave it. */
export async function diaryOf(workspaceId: string, userId: string, from: string, to: string) {
  const mine = sql`c.workspace_id = ${workspaceId} and c.created_by = ${userId}`;
  const head = sql`c.id as "caseId", c.title, coalesce(o.doc->'header'->>'caseNumber', '') as "caseNumber"`;
  const dates = sql`from cases c join case_offices o on o.case_id = c.id, jsonb_array_elements(o.doc->'dates') d`;
  const pick = sql`d->>'id' as id, d->>'date' as date, d->>'court' as court, d->>'purpose' as purpose`;
  const [upcoming, waiting, tasks] = await Promise.all([
    db.execute<DiaryDate>(sql`select ${head}, ${pick} ${dates}
      where ${mine} and d->>'date' between ${from} and ${to} order by d->>'date', c.title`),
    db.execute<DiaryDate>(sql`select ${head}, ${pick} ${dates}
      where ${mine} and d->>'date' < ${from} and jsonb_typeof(d->'outcome') is distinct from 'string'
      order by d->>'date' limit 50`),
    db.execute<DiaryTask>(sql`select ${head}, t->>'id' as id, t->>'title' as task, t->>'due' as due
      from cases c join case_offices o on o.case_id = c.id, jsonb_array_elements(o.doc->'tasks') t
      where ${mine} and (t->>'done')::boolean = false and t->>'due' <= ${to}
      order by t->>'due', c.title limit 100`),
  ]);
  return { upcoming: upcoming.rows, waiting: waiting.rows, tasks: tasks.rows };
}
