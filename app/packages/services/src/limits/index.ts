// Limits (docs/APP.md, Limits): checked before a chat turn and before a case upload, shown on /usage, edited on
// /admin. The rules are in rules.ts; here the counts and the config come from the database.
import {
  activeUserPlans,
  allPlans,
  caseAuthor,
  caseFileCount,
  deletePlan,
  deleteUserLimit,
  endUserPlan,
  insertPlan,
  insertUserPlan,
  ownedBytes,
  renamePlan,
  setDefaultPlan,
  setPlanLimit,
  upsertUserLimit,
  userCounters,
  userDailySpend,
  userLimitRows,
  userPlanHistory,
} from "@sllaw/db";
import { meter } from "@sllaw/usage";
import type { Signed } from "../files";
import { dayOf, monthOf } from "../periods";
import {
  CHAT_METRICS,
  isMetric,
  LimitReached,
  METRIC_KEYS,
  METRICS,
  type Metric,
  maxesOf,
  over,
  type Plan,
  planOf,
  resetOf,
  SPEND_METRICS,
} from "./rules";

export * from "./rules";

// Plans change rarely and only on /admin: cached for a minute (an edit clears this instance's copy at once; other
// instances see it within the minute). A user's own plan rows and limits are read every time (two indexed reads).
const TTL = 60_000;
let cache: { at: number; plans: Promise<Plan[]> } | null = null;
const plansNow = () => {
  if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), plans: allPlans() };
  return cache.plans;
};
const changed = () => void (cache = null);

/** A user's plan and the max for every metric, now. */
async function limitsOf(userId: string, now = new Date()) {
  const [plans, rows, own] = await Promise.all([plansNow(), activeUserPlans(userId, now), userLimitRows(userId)]);
  const plan = planOf(plans, rows, now);
  return { plan, own, maxes: maxesOf(plan, own, now) };
}

/** What a user has used of each metric (caps: storage only; files per case is per case, so not listed). */
async function usedBy(userId: string, now = new Date()): Promise<Record<Exclude<Metric, "case_files">, number>> {
  const [c, bytes] = await Promise.all([userCounters(userId, dayOf(now).from, monthOf(now).from), ownedBytes(userId)]);
  return {
    messages: c.messages,
    spend: c.spend,
    spend_month: c.spendMonth,
    searches: c.searches,
    storage: bytes,
  } satisfies Partial<Record<Metric, number>>;
}

/** Throws LimitReached for the first of `metrics` used up. */
async function check(userId: string, metrics: readonly Metric[], now: Date) {
  const [{ plan, maxes }, used] = await Promise.all([limitsOf(userId, now), usedBy(userId, now)]);
  for (const m of metrics) {
    const { max } = maxes[m];
    const u = used[m as keyof typeof used];
    if (over(m, u, max)) throw new LimitReached(m, u, max!, plan?.name ?? "current", resetOf(m, now));
  }
}

/** Before a chat turn: throws LimitReached when a daily or monthly counter (messages, spend, searches) is used up.
 *  Platform staff are not limited. Two turns sent at the same moment can both pass (one over): fine for daily
 *  counts, and a turn that starts under the allowance finishes and counts. */
export async function checkChat(a: Signed, now = new Date()) {
  if (a.user.isAdmin) return;
  await check(a.user.id, CHAT_METRICS, now);
}

/** Before model work that is not a chat turn (an upload, finishing it, reprocessing a file, re-typing one): throws
 *  LimitReached when the user's spend a day or a month is used up. Platform staff are not limited. Work already
 *  started finishes and counts. */
export async function checkSpend(user: { id: string; isAdmin?: boolean }, now = new Date()) {
  if (!user.isAdmin) await check(user.id, SPEND_METRICS, now);
}

/** Records a message sent: the messages counter. After the message is stored; idem keeps a retried write single. */
export const meterMessage = (a: Signed, chatId: string, messageId: string) =>
  meter(
    { kind: "action", quantity: { messages: 1 }, idem: `chat.message:${messageId}` },
    { workspaceId: a.workspace.id, userId: a.user.id, task: "chat.message", ref: `chat:${chatId}` },
  );

/** Before a file is added to a case: the uploader's spend, the case's file count against its author's plan, and the
 *  uploader's storage with this file's size. */
export async function checkCaseUpload(a: Signed, caseId: string, size: number) {
  if (a.user.isAdmin) return;
  await checkSpend(a.user); // its processing is model work for the uploader
  const author = (await caseAuthor(caseId)) ?? a.user.id;
  const [mine, theirs, inCase, bytes] = await Promise.all([
    limitsOf(a.user.id),
    author === a.user.id ? null : limitsOf(author),
    caseFileCount(caseId),
    ownedBytes(a.user.id),
  ]);
  const caseLimits = theirs ?? mine;
  const files = caseLimits.maxes.case_files.max;
  if (over("case_files", inCase, files, 1))
    throw new LimitReached("case_files", inCase, files!, caseLimits.plan?.name ?? "current", null);
  const store = mine.maxes.storage.max;
  if (over("storage", bytes, store, size))
    throw new LimitReached("storage", bytes, store!, mine.plan?.name ?? "current", null);
}

/** Before a file is read for a new case (no case yet): the uploader's spend and storage with this file's size. */
export async function checkDraftUpload(a: Signed, size: number) {
  if (a.user.isAdmin) return;
  await checkSpend(a.user);
  const [mine, bytes] = await Promise.all([limitsOf(a.user.id), ownedBytes(a.user.id)]);
  const store = mine.maxes.storage.max;
  if (over("storage", bytes, store, size))
    throw new LimitReached("storage", bytes, store!, mine.plan?.name ?? "current", null);
}

/** Before a new case is made with `count` files: the case's file count against the user's plan. */
export async function checkNewCaseFiles(a: Signed, count: number) {
  if (a.user.isAdmin || !count) return;
  const mine = await limitsOf(a.user.id);
  const files = mine.maxes.case_files.max;
  if (over("case_files", 0, files, count))
    throw new LimitReached("case_files", count, files!, mine.plan?.name ?? "current", null);
}

/** A user's plan, each limit with what is used and when it resets, and their spend per day this month (every day up
 *  to today, 0 when none): the /usage page, and the user's row on /admin. Lawyers never see money (brief
 *  spend-limits): unless `money` (staff), spend is sent as percent of the allowance (max 100; unlimited: no numbers)
 *  and each day as percent of the daily allowance. */
export async function usageStatus(userId: string, { money = false } = {}, now = new Date()) {
  const month = monthOf(now);
  const [{ plan, maxes }, used, daily] = await Promise.all([
    limitsOf(userId, now),
    usedBy(userId, now),
    userDailySpend(userId, month.from, dayOf(now).to),
  ]);
  const share = (v: number, max: number | null) => (max ? (v / max) * 100 : null);
  const dayMax = maxes.spend.max;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const days: { day: string; spend: number; messages: number }[] = [];
  for (let t = month.from.getTime(); t < dayOf(now).to.getTime(); t += 86_400_000) {
    const day = new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10); // the Colombo date of that midnight
    const d = byDay.get(day) ?? { day, spend: 0, messages: 0 };
    days.push(money ? d : { ...d, spend: share(d.spend, dayMax) ?? 0 });
  }
  return {
    plan: plan && { key: plan.key, name: plan.name },
    money,
    limits: METRIC_KEYS.map((m) => {
      const { max, source } = maxes[m];
      const u = m === "case_files" ? null : used[m];
      const hide = !money && METRICS[m].unit === "usd";
      return {
        metric: m,
        ...METRICS[m],
        label: hide ? (METRICS[m].per === "day" ? "Today's allowance" : "This month's allowance") : METRICS[m].label,
        unit: hide ? ("percent" as const) : METRICS[m].unit,
        used: hide && u != null ? share(u, max) : u,
        max: hide && max != null ? 100 : max,
        source,
        resetsAt: resetOf(m, now),
      };
    }),
    days: money || dayMax ? days : [],
  };
}

// ---- platform staff (/admin): the api lets only superAdmin call these ----

/** Every plan with its limits, and the metrics a limit can be set on (labels and units for the editor). */
export const adminPlans = async () => ({
  plans: await allPlans(),
  metrics: METRIC_KEYS.map((m) => ({ metric: m, ...METRICS[m] })),
});

export async function adminSavePlan(p: { id?: string; key: string; name: string }) {
  if (p.id) await renamePlan(p.id, p.name);
  else await insertPlan({ key: p.key, name: p.name });
  changed();
}

export async function adminDeletePlan(id: string) {
  const ok = await deletePlan(id);
  changed();
  return ok;
}

export async function adminSetDefaultPlan(id: string) {
  await setDefaultPlan(id);
  changed();
}

export async function adminSetPlanLimit(planId: string, metric: string, max: number | null) {
  if (!isMetric(metric)) throw new Error(`unknown metric: ${metric}`);
  await setPlanLimit(planId, metric, max);
  changed();
}

/** A user's limits for the admin page: status, every plan row they have had, and their own limits. */
export async function adminUserLimits(userId: string) {
  const [status, history, own] = await Promise.all([
    usageStatus(userId, { money: true }),
    userPlanHistory(userId),
    userLimitRows(userId),
  ]);
  return { ...status, history, own };
}

/** Gives a user a plan from now (or `startsAt`) until endsAt (null: no end). It wins over older active rows. */
export const adminGiveUserPlan = (
  staff: Signed["user"],
  p: { userId: string; planId: string; startsAt?: Date; endsAt: Date | null; note: string | null },
) => insertUserPlan({ ...p, source: "staff", setBy: staff.id });

export const adminEndUserPlan = (userId: string, id: string) => endUserPlan(id, userId);

export async function adminSetUserLimit(
  staff: Signed["user"],
  l: { userId: string; metric: string; max: number | null; expiresAt: Date | null; note: string | null },
) {
  if (!isMetric(l.metric)) throw new Error(`unknown metric: ${l.metric}`);
  await upsertUserLimit({ ...l, setBy: staff.id });
}

export const adminRemoveUserLimit = (userId: string, metric: string) => deleteUserLimit(userId, metric);
