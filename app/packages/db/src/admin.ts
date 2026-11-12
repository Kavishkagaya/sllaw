// Queries for the platform admin pages (/admin, superAdmin): every user and workspace, and usage summed over them.
// Raw SQL: these are reports (filtered aggregates over usage_events' jsonb), not row reads.
import { sql } from "drizzle-orm";
import { db } from "./client";

export type Period = { from: Date; to: Date };

/** What a set of usage events adds up to; the same columns for any grouping. */
export type UsageTotals = {
  costUsd: number;
  events: number;
  llmCalls: number;
  tokens: number; // model input + output
  embedTokens: number;
  ocrPages: number;
  uploadedBytes: number;
  chats: number; // distinct chats with a model call
  files: number; // distinct files processed
};

const totals = sql`
  coalesce(sum(e.cost_usd), 0)::float8 as "costUsd",
  count(*)::int as "events",
  count(*) filter (where e.kind = 'llm')::int as "llmCalls",
  coalesce(sum(coalesce((e.quantity->>'input')::bigint, 0) + coalesce((e.quantity->>'output')::bigint, 0))
    filter (where e.kind = 'llm'), 0)::float8 as "tokens",
  coalesce(sum((e.quantity->>'tokens')::bigint) filter (where e.kind = 'embed'), 0)::float8 as "embedTokens",
  coalesce(sum((e.quantity->>'pages')::bigint) filter (where e.kind = 'ocr'), 0)::float8 as "ocrPages",
  coalesce(sum((e.quantity->>'bytes')::bigint) filter (where e.kind = 'storage'), 0)::float8 as "uploadedBytes",
  count(distinct e.ref) filter (where e.ref like 'chat:%')::int as "chats",
  count(distinct e.ref) filter (where e.ref like 'file:%')::int as "files"`;

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];
// raw rows carry timestamps as text
const dated = <T extends { createdAt: Date }>(xs: T[]) => xs.map((x) => ({ ...x, createdAt: new Date(x.createdAt) }));
const within = (p: Period) => sql`e.at >= ${p.from} and e.at < ${p.to}`;

/** Usage over the period, all workspaces together. */
export const usageTotal = async (p: Period) =>
  (await rows<UsageTotals>(sql`select ${totals} from usage_events e where ${within(p)}`))[0]!;

/** Model calls over the period, everyone's: what the gateway billed us by our ledger, how many, how many estimated. */
export const llmSpend = async (p: Period) =>
  (
    await rows<{ costUsd: number; calls: number; estimated: number }>(sql`
      select coalesce(sum(e.cost_usd), 0)::float8 as "costUsd", count(*)::int as calls,
        count(*) filter (where e.estimated)::int as estimated
      from usage_events e where e.kind = 'llm' and ${within(p)}`)
  )[0]!;

/** One user's model spend per file over the period (processing, re-typing), the most first; name null once deleted. */
export const userFileSpend = (p: Period, userId: string) =>
  rows<{
    fileId: string;
    name: string | null;
    costUsd: number;
    calls: number;
    tasks: string[];
    estimated: boolean;
  }>(sql`
    select substr(e.ref, 6) as "fileId", f.name, coalesce(sum(e.cost_usd), 0)::float8 as "costUsd",
      count(*)::int as calls, array_agg(distinct e.task) as tasks, bool_or(e.estimated) as estimated
    from usage_events e left join files f on f.id::text = substr(e.ref, 6)
    where e.kind = 'llm' and e.user_id = ${userId} and e.ref like 'file:%' and ${within(p)}
    group by 1, 2 order by 3 desc limit 50`);

/** Usage per workspace over the period (workspace_id null: metered outside any scope). */
export const usageByWorkspace = (p: Period) =>
  rows<UsageTotals & { workspaceId: string | null }>(sql`
    select e.workspace_id as "workspaceId", ${totals}
    from usage_events e where ${within(p)}
    group by e.workspace_id`);

/** Usage per user over the period, in one workspace or all (user_id null: no user, e.g. a script). */
export const usageByUser = (p: Period, workspaceId?: string) =>
  rows<UsageTotals & { userId: string | null }>(sql`
    select e.user_id as "userId", ${totals}
    from usage_events e
    where ${within(p)} ${workspaceId ? sql`and e.workspace_id = ${workspaceId}` : sql``}
    group by e.user_id`);

/** One workspace's or user's usage per kind, task and model, with each quantity summed. */
export async function usageBreakdown(p: Period, f: { workspaceId?: string; userId?: string }) {
  const where = sql`${within(p)}
    ${f.workspaceId ? sql`and e.workspace_id = ${f.workspaceId}` : sql``}
    ${f.userId ? sql`and e.user_id = ${f.userId}` : sql``}`;
  const [groups, quantities] = await Promise.all([
    rows<{ kind: string; task: string; model: string | null; events: number; costUsd: number; estimated: boolean }>(sql`
      select e.kind, e.task, e.model, count(*)::int as events, coalesce(sum(e.cost_usd), 0)::float8 as "costUsd",
        bool_or(e.estimated) as estimated
      from usage_events e where ${where}
      group by e.kind, e.task, e.model
      order by "costUsd" desc, events desc`),
    rows<{ kind: string; task: string; model: string | null; key: string; sum: number }>(sql`
      select e.kind, e.task, e.model, q.key, sum(q.value::numeric)::float8 as sum
      from usage_events e, jsonb_each_text(e.quantity) q where ${where}
      group by e.kind, e.task, e.model, q.key`),
  ]);
  const id = (r: { kind: string; task: string; model: string | null }) => `${r.kind}|${r.task}|${r.model}`;
  const byId = new Map(groups.map((g) => [id(g), { ...g, quantity: {} as Record<string, number> }]));
  for (const q of quantities) {
    const g = byId.get(id(q));
    if (g) g.quantity[q.key] = q.sum;
  }
  return [...byId.values()];
}

/** Cost per day (Asia/Colombo) over the period, for one workspace or user or all. */
export const usageDaily = (p: Period, f: { workspaceId?: string; userId?: string } = {}) =>
  rows<{ day: string; costUsd: number; events: number }>(sql`
    select to_char(e.at at time zone 'Asia/Colombo', 'YYYY-MM-DD') as day,
      coalesce(sum(e.cost_usd), 0)::float8 as "costUsd", count(*)::int as events
    from usage_events e
    where ${within(p)}
      ${f.workspaceId ? sql`and e.workspace_id = ${f.workspaceId}` : sql``}
      ${f.userId ? sql`and e.user_id = ${f.userId}` : sql``}
    group by 1 order by 1`);

export type AdminUser = {
  id: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
  isAdmin: boolean;
  createdAt: Date;
  workspaces: { id: string; name: string; role: string }[];
  chats: number;
  cases: number;
};

const userCols = sql`
  u.id, u.email, u.name, u.image_url as "imageUrl", u.is_admin as "isAdmin", u.created_at as "createdAt",
  coalesce((select json_agg(json_build_object('id', w.id, 'name', w.name, 'role', wu.role) order by w.name)
    from workspace_users wu join workspaces w on w.id = wu.workspace_id where wu.user_id = u.id), '[]') as workspaces,
  (select count(*)::int from chats c where c.user_id = u.id) as chats,
  (select count(*)::int from cases c where c.created_by = u.id) as cases`;

/** Every user with their workspaces (and role in each), newest first. */
export const allUsers = async () =>
  dated(await rows<AdminUser>(sql`select ${userCols} from users u order by u.created_at desc`));

export const adminUser = async (id: string) =>
  dated(await rows<AdminUser>(sql`select ${userCols} from users u where u.id = ${id}`))[0] ?? null;

export type AdminWorkspace = {
  id: string;
  name: string;
  slug: string | null;
  createdAt: Date;
  members: number;
  cases: number;
  files: number;
  storedBytes: number;
};

const workspaceCols = sql`
  w.id, w.name, w.slug, w.created_at as "createdAt",
  (select count(*)::int from workspace_users wu where wu.workspace_id = w.id) as members,
  (select count(*)::int from cases c where c.workspace_id = w.id) as cases,
  (select count(*)::int from files f where f.workspace_id = w.id and f.upload_state = 'stored') as files,
  (select coalesce(sum(f.size), 0)::float8 from files f where f.workspace_id = w.id and f.upload_state = 'stored')
    as "storedBytes"`;

/** Every workspace with its members, cases, files and bytes stored now, newest first. */
export const allWorkspaces = async () =>
  dated(await rows<AdminWorkspace>(sql`select ${workspaceCols} from workspaces w order by w.created_at desc`));

export const adminWorkspace = async (id: string) =>
  dated(await rows<AdminWorkspace>(sql`select ${workspaceCols} from workspaces w where w.id = ${id}`))[0] ?? null;

/** A workspace's members with their role, as users. */
export const workspaceMembers = (workspaceId: string) =>
  rows<{ id: string; email: string | null; name: string | null; imageUrl: string | null; role: string }>(sql`
    select u.id, u.email, u.name, u.image_url as "imageUrl", wu.role
    from workspace_users wu join users u on u.id = wu.user_id
    where wu.workspace_id = ${workspaceId} order by u.name`);
