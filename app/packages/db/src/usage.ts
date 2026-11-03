import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "./client";
import { usageEvents } from "./schema";

export type UsageRow = typeof usageEvents.$inferInsert;

/** Appends events; one already stored under the same idem (a retried write) is skipped. */
export async function insertUsage(rows: UsageRow[]) {
  if (!rows.length) return;
  await db.insert(usageEvents).values(rows).onConflictDoNothing({ target: usageEvents.idem });
}

/** A workspace's usage in [from, to): per kind, task and model, the number of events, the cost, and each quantity
 *  (tokens, pages, bytes...) summed. */
export async function usageSummary(workspaceId: string, from: Date, to: Date) {
  const where = and(eq(usageEvents.workspaceId, workspaceId), gte(usageEvents.at, from), lt(usageEvents.at, to));
  const group = [usageEvents.kind, usageEvents.task, usageEvents.model] as const;
  const [totals, quantities] = await Promise.all([
    db
      .select({
        kind: usageEvents.kind,
        task: usageEvents.task,
        model: usageEvents.model,
        events: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(...group),
    db
      .execute<{ kind: string; task: string; model: string | null; key: string; sum: number }>(sql`
        select e.kind, e.task, e.model, q.key, sum(q.value::numeric)::float8 as sum
        from usage_events e, jsonb_each_text(e.quantity) q
        where e.workspace_id = ${workspaceId} and e.at >= ${from} and e.at < ${to}
        group by e.kind, e.task, e.model, q.key`)
      .then((r) => r.rows),
  ]);
  const id = (r: { kind: string; task: string; model: string | null }) => `${r.kind}|${r.task}|${r.model}`;
  const byId = new Map(totals.map((t) => [id(t), { ...t, quantity: {} as Record<string, number> }]));
  for (const q of quantities) {
    const t = byId.get(id(q));
    if (t) t.quantity[q.key] = q.sum;
  }
  return [...byId.values()];
}

/** What a workspace spent in [from, to), in USD: the number a plan's limit is checked against. */
export async function usageCost(workspaceId: string, from: Date, to: Date) {
  const [r] = await db
    .select({ costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
    .from(usageEvents)
    .where(and(eq(usageEvents.workspaceId, workspaceId), gte(usageEvents.at, from), lt(usageEvents.at, to)));
  return r?.costUsd ?? 0;
}
