// The platform admin pages (/admin): every user and workspace and what each used. The api lets only superAdmin
// (users.is_admin) call these; to anyone else they do not exist (NOT_FOUND, no link, nothing in the client bundle).
import {
  adminUser,
  adminWorkspace,
  allUsers,
  allWorkspaces,
  type Period,
  type UsageTotals,
  usageBreakdown,
  usageByUser,
  usageByWorkspace,
  usageDaily,
  usageTotal,
  workspaceMembers,
} from "@sllaw/db";
import { type PeriodName, periodOf, previousOf } from "./periods";

const none: UsageTotals = {
  costUsd: 0,
  events: 0,
  llmCalls: 0,
  tokens: 0,
  embedTokens: 0,
  ocrPages: 0,
  uploadedBytes: 0,
  chats: 0,
  files: 0,
};

/** Every user, with what each used over the period; the most spent first, then the newest. */
export async function adminUsers(name?: PeriodName) {
  const p = periodOf(name);
  const [users, usage] = await Promise.all([allUsers(), usageByUser(p)]);
  const byUser = new Map(usage.map((u) => [u.userId, u]));
  return {
    ...p,
    users: users
      .map((u) => ({ ...u, usage: byUser.get(u.id) ?? none }))
      .sort((a, b) => b.usage.costUsd - a.usage.costUsd || +new Date(b.createdAt) - +new Date(a.createdAt)),
  };
}

/** The whole platform over the period: totals, per day, per workspace (every workspace, used or not) and per user. */
export async function adminUsage(name?: PeriodName) {
  const p = periodOf(name);
  const [total, daily, byWs, workspaces, byUser, users] = await Promise.all([
    usageTotal(p),
    usageDaily(p),
    usageByWorkspace(p),
    allWorkspaces(),
    usageByUser(p),
    allUsers(),
  ]);
  const wsUsage = new Map(byWs.map((w) => [w.workspaceId, w]));
  const userById = new Map(users.map((u) => [u.id, u]));
  return {
    ...p,
    total,
    daily,
    workspaces: workspaces
      .map((w) => ({ ...w, usage: wsUsage.get(w.id) ?? none }))
      .sort((a, b) => b.usage.costUsd - a.usage.costUsd),
    // usage whose workspace is gone or was never set (scripts): kept visible so totals add up
    unattributed: byWs.filter((w) => !w.workspaceId || !workspaces.some((x) => x.id === w.workspaceId)),
    users: byUser
      .map((u) => {
        const user = u.userId ? userById.get(u.userId) : undefined;
        return { userId: u.userId, name: user?.name ?? null, email: user?.email ?? null, usage: u };
      })
      .sort((a, b) => b.usage.costUsd - a.usage.costUsd),
  };
}

/** One workspace: its members (with what each used), usage per kind/task/model and per day. null when not there. */
export async function adminWorkspaceUsage(id: string, name?: PeriodName) {
  const p = periodOf(name);
  const workspace = await adminWorkspace(id);
  if (!workspace) return null;
  const [members, byUser, breakdown, daily] = await Promise.all([
    workspaceMembers(id),
    usageByUser(p, id),
    usageBreakdown(p, { workspaceId: id }),
    usageDaily(p, { workspaceId: id }),
  ]);
  const used = new Map(byUser.map((u) => [u.userId, u]));
  return {
    ...p,
    workspace,
    total: breakdown.reduce((s, b) => s + b.costUsd, 0),
    members: members
      .map((m) => ({ ...m, usage: used.get(m.id) ?? none }))
      .sort((a, b) => b.usage.costUsd - a.usage.costUsd),
    breakdown,
    daily,
  };
}

/** One user: their workspaces, usage per kind/task/model, per workspace and per day. null when not there. */
export async function adminUserUsage(id: string, name?: PeriodName) {
  const p = periodOf(name);
  const user = await adminUser(id);
  if (!user) return null;
  const [breakdown, daily, perWs] = await Promise.all([
    usageBreakdown(p, { userId: id }),
    usageDaily(p, { userId: id }),
    Promise.all(
      user.workspaces.map(async (w) => ({
        ...w,
        usage: (await usageByUser(p, w.id)).find((u) => u.userId === id) ?? none,
      })),
    ),
  ]);
  return { ...p, user, total: breakdown.reduce((s, b) => s + b.costUsd, 0), breakdown, daily, workspaces: perWs };
}

const colombo = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }); // YYYY-MM-DD

/** Every day of the period up to today (Asia/Colombo), with 0 for a day with no usage. */
function everyDay(p: Period, daily: { day: string; costUsd: number; events: number }[]) {
  const got = new Map(daily.map((d) => [d.day, d]));
  const end = Math.min(p.to.getTime(), Date.now());
  const out: { day: string; costUsd: number; events: number }[] = [];
  const seen = new Set<string>();
  for (let t = p.from.getTime(); t < end; t += 3_600_000) {
    const day = colombo.format(new Date(t));
    if (seen.has(day)) continue;
    seen.add(day);
    out.push(got.get(day) ?? { day, costUsd: 0, events: 0 });
  }
  return out;
}

/** The admin home: the period against the one before it, cost per day, who is active, the top spenders and the
 *  newest users. */
export async function adminDashboard(name: PeriodName = "month") {
  const p = periodOf(name);
  const prev = previousOf(name, p);
  const [total, before, daily, byWs, byUser, users, workspaces] = await Promise.all([
    usageTotal(p),
    usageTotal(prev),
    usageDaily(p),
    usageByWorkspace(p),
    usageByUser(p),
    allUsers(),
    allWorkspaces(),
  ]);
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const user = new Map(users.map((u) => [u.id, u]));
  const inPeriod = (d: Date) => d >= p.from && d < p.to;
  return {
    ...p,
    previous: prev,
    total,
    before,
    daily: everyDay(p, daily),
    users: {
      total: users.length,
      new: users.filter((u) => inPeriod(u.createdAt)).length,
      active: byUser.filter((u) => u.userId && u.events > 0).length,
    },
    workspaces: {
      total: workspaces.length,
      new: workspaces.filter((w) => inPeriod(w.createdAt)).length,
      active: byWs.filter((w) => w.workspaceId && wsName.has(w.workspaceId)).length,
      storedBytes: workspaces.reduce((s, w) => s + w.storedBytes, 0),
    },
    topWorkspaces: byWs
      .filter((w) => w.workspaceId && wsName.has(w.workspaceId))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5)
      .map((w) => ({ id: w.workspaceId!, name: wsName.get(w.workspaceId!)!, usage: w })),
    topUsers: byUser
      .filter((u) => u.userId && user.has(u.userId))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5)
      .map((u) => ({ id: u.userId!, name: user.get(u.userId!)!.name, email: user.get(u.userId!)!.email, usage: u })),
    newestUsers: users.slice(0, 5).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      workspaces: u.workspaces.map((w) => w.name),
    })),
  };
}
