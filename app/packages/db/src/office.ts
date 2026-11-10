// Case offices and their change history (schema: case_offices, case_changes). Who may read or change one is the case
// service's; what a valid office is, @sllaw/office's.
import type { Item, Office } from "@sllaw/office";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { caseChanges, caseOffices } from "./schema";

/** The stored office and its version; null when the case has none yet (it then has the empty office, version 0). */
export async function officeOf(caseId: string) {
  const [r] = await db
    .select({ doc: caseOffices.doc, version: caseOffices.version })
    .from(caseOffices)
    .where(eq(caseOffices.caseId, caseId));
  return r ?? null;
}

export type NewChange = {
  by: "lawyer" | "ai";
  userId: string;
  chatId?: string | null;
  summary: string;
  items: Item[];
  undoes?: string | null;
};

/** Writes the office if it is still at `version` and records the change, in one statement (the HTTP driver has no
 *  transactions): the change row exists only when the office was written. An undo marks the change it undid.
 *  Returns the change's id, or null when someone else wrote first (the caller reads again and retries). */
export async function saveOffice(caseId: string, version: number, doc: Office, c: NewChange): Promise<string | null> {
  const json = JSON.stringify(doc);
  const write =
    version === 0
      ? sql`insert into ${caseOffices} (case_id, doc, version) values (${caseId}, ${json}::jsonb, 1)
            on conflict (case_id) do nothing returning case_id`
      : sql`update ${caseOffices} set doc = ${json}::jsonb, version = version + 1, updated_at = now()
            where case_id = ${caseId} and version = ${version}
              -- an undo writes only while its change is still not undone (two undos at once: one wins)
              and not exists (select 1 from ${caseChanges} x where x.id = ${c.undoes ?? null}::uuid and x.undone_by is not null)
            returning case_id`;
  const r = await db.execute<{ id: string }>(sql`
    with w as (${write}),
    c as (
      insert into ${caseChanges} (case_id, by, user_id, chat_id, summary, items, undoes)
      select w.case_id, ${c.by}, ${c.userId}, ${c.chatId ?? null}, ${c.summary}, ${JSON.stringify(c.items)}::jsonb,
             ${c.undoes ?? null}::uuid
      from w returning id
    ),
    u as (
      update ${caseChanges} set undone_by = (select id from c)
      where id = ${c.undoes ?? null}::uuid and exists (select 1 from c) returning id
    )
    select id from c`);
  return r.rows[0]?.id ?? null;
}

// shortcut: case_changes is never pruned (each row holds the touched items' before and after); prune old rows once
// Neon storage shows it.
/** A case's changes, newest first, without their items. */
export const changesOf = (caseId: string, limit = 50) =>
  db
    .select({
      id: caseChanges.id,
      by: caseChanges.by,
      chatId: caseChanges.chatId,
      summary: caseChanges.summary,
      undoes: caseChanges.undoes,
      undoneBy: caseChanges.undoneBy,
      createdAt: caseChanges.createdAt,
    })
    .from(caseChanges)
    .where(eq(caseChanges.caseId, caseId))
    .orderBy(desc(caseChanges.createdAt))
    .limit(limit);

export async function changeOf(caseId: string, changeId: string) {
  const [r] = await db
    .select()
    .from(caseChanges)
    .where(and(eq(caseChanges.caseId, caseId), eq(caseChanges.id, changeId)));
  return r ?? null;
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
