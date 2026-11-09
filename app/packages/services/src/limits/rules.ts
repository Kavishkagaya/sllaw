// What a limit is, and which max applies to a user: no database here (rules.test.ts). docs/APP.md, Limits.
//
// Two kinds of metric. A counter counts what the user did in a period (a Sri Lanka day or month), from usage_events,
// so deleting a chat or a case gives nothing back; it resets at midnight or on the 1st. A cap counts what exists now
// (files in a case, bytes stored), from the tables; deleting frees room. Every limit is the user's, across all their
// workspaces: one allowance per lawyer.
import { dayOf, monthOf } from "../periods";

export const METRICS = {
  messages: { kind: "counter", per: "day", unit: "count", label: "Messages a day" },
  tokens: { kind: "counter", per: "day", unit: "tokens", label: "Context a day" },
  tokens_month: { kind: "counter", per: "month", unit: "tokens", label: "Context a month" },
  searches: { kind: "counter", per: "day", unit: "count", label: "Searches a day" },
  case_files: { kind: "cap", per: "case", unit: "count", label: "Files per case" },
  storage: { kind: "cap", per: "user", unit: "bytes", label: "Storage" },
} as const;

export type Metric = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as Metric[];
export const isMetric = (m: string): m is Metric => m in METRICS;

/** What a chat turn and a case upload are checked against. */
export const CHAT_METRICS = ["messages", "tokens", "tokens_month", "searches"] as const satisfies Metric[];

export type Plan = { id: string; key: string; name: string; isDefault: boolean; limits: Record<string, number> };
export type UserPlan = { planId: string; startsAt: Date; endsAt: Date | null };
export type UserLimit = { metric: string; max: number | null; expiresAt: Date | null; note: string | null };

/** Where a max came from: the user's own limit, or their plan. */
export type Source = "user" | "plan";
export type Max = { max: number | null; source: Source };

/** The user's plan at `now`: the active row with the latest start whose plan still exists, else the default. */
export function planOf(plans: Plan[], rows: UserPlan[], now = new Date()): Plan | null {
  const active = rows
    .filter((r) => r.startsAt <= now && (!r.endsAt || r.endsAt > now))
    .sort((a, b) => +b.startsAt - +a.startsAt);
  for (const r of active) {
    const p = plans.find((x) => x.id === r.planId);
    if (p) return p;
  }
  return plans.find((p) => p.isDefault) ?? null;
}

/** The max for each metric: the user's own limit while it has not expired, else the plan's; null = unlimited (no
 *  plan row, a user limit of null, or no plan at all). */
export function maxesOf(plan: Plan | null, own: UserLimit[], now = new Date()): Record<Metric, Max> {
  const out = {} as Record<Metric, Max>;
  for (const m of METRIC_KEYS) {
    const u = own.find((l) => l.metric === m && (!l.expiresAt || l.expiresAt > now));
    out[m] = u ? { max: u.max, source: "user" } : { max: plan?.limits[m] ?? null, source: "plan" };
  }
  return out;
}

/** When a metric's count starts over: the next Sri Lanka midnight or 1st; null for a cap. */
export function resetOf(m: Metric, now = new Date()): Date | null {
  const per = METRICS[m].per;
  return per === "day" ? dayOf(now).to : per === "month" ? monthOf(now).to : null;
}

/** Whether `used` (plus what the action adds) goes past max. A counter blocks once it is reached: the action about
 *  to start would add to it (a turn that starts under the limit may end over it). A cap blocks when adding would
 *  exceed it. */
export function over(m: Metric, used: number, max: number | null, adding = 0) {
  if (max == null) return false;
  return METRICS[m].kind === "counter" ? used >= max : used + adding > max;
}

const num = new Intl.NumberFormat("en-GB");
const size = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB` : `${Math.round(b / 1024 ** 2)} MB`;
const monthDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" });

/** A limit reached: what the user is told (chat 429, upload error), and the numbers for the UI. */
export class LimitReached extends Error {
  constructor(
    readonly metric: Metric,
    readonly used: number,
    readonly max: number,
    readonly plan: string,
    readonly resetsAt: Date | null,
  ) {
    super(limitMessage(metric, max, plan, resetsAt));
    this.name = "LimitReached";
  }
}

export function limitMessage(m: Metric, max: number, plan: string, resetsAt: Date | null) {
  const at =
    resetsAt && METRICS[m].per === "month" ? `on ${monthDay.format(resetsAt)}` : "at midnight (Sri Lanka time)";
  switch (m) {
    case "messages":
      return `You have sent today's ${num.format(max)} messages on the ${plan} plan. You can send more ${at}.`;
    case "tokens":
      return `You have used today's context allowance on the ${plan} plan (${num.format(max)} tokens). It resets ${at}.`;
    case "tokens_month":
      return `You have used this month's context allowance on the ${plan} plan (${num.format(max)} tokens). It resets ${at}.`;
    case "searches":
      return `You have reached today's ${num.format(max)} searches on the ${plan} plan. It resets ${at}.`;
    case "case_files":
      return `This case has ${num.format(max)} files, the most the ${plan} plan allows. Remove one to add another.`;
    case "storage":
      return `This file would take you past your ${size(max)} of storage on the ${plan} plan. Delete files to make room.`;
  }
}
