// Where metered usage goes (@sllaw/usage, docs/APP.md Usage): the app database's usage_events. Set once, when services
// is first imported; the packages that spend call meter() and never see the database.
import { insertUsage, usageCost, usageSummary } from "@sllaw/db";
import { type Metered, setUsageSink } from "@sllaw/usage";
import type { Signed } from "./files";
import { monthOf } from "./periods";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (s: string | null) => (s && UUID.test(s) ? s : null);

export const toRow = (m: Metered) => ({
  at: m.at,
  workspaceId: uuidOrNull(m.workspaceId),
  userId: uuidOrNull(m.userId),
  kind: m.kind,
  task: m.task,
  model: m.model ?? null,
  quantity: m.quantity,
  costUsd: m.costUsd ?? null,
  estimated: m.estimated ?? false,
  ref: m.ref,
  idem: m.idem ?? null,
  meta: m.meta ?? null,
});

setUsageSink((events) => insertUsage(events.map(toRow)));

/** The active workspace's usage over [from, to) (default: this month): per kind, task and model, and the total. */
export async function workspaceUsage(a: Signed, period = monthOf()) {
  const rows = await usageSummary(a.workspace.id, period.from, period.to);
  return { ...period, costUsd: rows.reduce((s, r) => s + r.costUsd, 0), rows };
}

/** What the active workspace spent this month, in USD: what a plan's limit will be checked against. */
export const workspaceSpend = (a: Signed, period = monthOf()) => usageCost(a.workspace.id, period.from, period.to);
