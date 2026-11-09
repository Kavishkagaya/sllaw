// Plans, limits and the counts they are checked against (docs/APP.md, Limits). Counters come from usage_events,
// which outlive deleted chats, cases and files; caps count what exists now. Which metric is which is services'.
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "./client";
import { caseFiles, cases, files, planLimits, plans, userLimits, userPlans } from "./schema";

export type PlanRow = typeof plans.$inferSelect;
export type UserPlanRow = typeof userPlans.$inferSelect;
export type UserLimitRow = typeof userLimits.$inferSelect;

/** Every plan with its limits ({ metric: max }), the default first. */
export async function allPlans() {
  const [ps, ls] = await Promise.all([
    db.select().from(plans).orderBy(sql`${plans.isDefault} desc`, asc(plans.createdAt)),
    db.select().from(planLimits),
  ]);
  return ps.map((p) => ({
    ...p,
    limits: Object.fromEntries(ls.filter((l) => l.planId === p.id).map((l) => [l.metric, l.max])) as Record<
      string,
      number
    >,
  }));
}

/** A user's plans active at `now`, the latest start first. */
export const activeUserPlans = (userId: string, now = new Date()) =>
  db
    .select()
    .from(userPlans)
    .where(
      and(
        eq(userPlans.userId, userId),
        lte(userPlans.startsAt, now),
        or(isNull(userPlans.endsAt), gt(userPlans.endsAt, now)),
      ),
    )
    .orderBy(sql`${userPlans.startsAt} desc`);

/** Every plan row a user has had, ended or not, the newest first: for the admin page. */
export const userPlanHistory = (userId: string) =>
  db.select().from(userPlans).where(eq(userPlans.userId, userId)).orderBy(sql`${userPlans.startsAt} desc`);

/** A user's own limits, expired ones included (the caller drops them). */
export const userLimitRows = (userId: string) => db.select().from(userLimits).where(eq(userLimits.userId, userId));

/** What a user used since `day` (today's midnight) and since `month` (the 1st), across all their workspaces:
 *  messages sent, chat model tokens (input + output, every step), and searches (Zilliz calls in a chat turn). */
export async function userCounters(userId: string, day: Date, month: Date) {
  const tokens = sql`coalesce((quantity->>'input')::bigint, 0) + coalesce((quantity->>'output')::bigint, 0)`;
  const r = await db.execute<{ messages: number; tokens: number; tokensMonth: number; searches: number }>(sql`
    select
      count(*) filter (where kind = 'action' and task = 'chat.message' and at >= ${day})::int as messages,
      coalesce(sum(${tokens}) filter (where kind = 'llm' and task = 'chat' and at >= ${day}), 0)::float8 as tokens,
      coalesce(sum(${tokens}) filter (where kind = 'llm' and task = 'chat'), 0)::float8 as "tokensMonth",
      count(*) filter (where kind = 'vector' and task = 'chat' and at >= ${day})::int as searches
    from usage_events
    where user_id = ${userId} and at >= ${month}`);
  return r.rows[0] ?? { messages: 0, tokens: 0, tokensMonth: 0, searches: 0 };
}

/** A user's chat model tokens per day (Sri Lanka days) in [from, to): the usage graph. Days with none are left out. */
export async function userDailyTokens(userId: string, from: Date, to: Date) {
  const r = await db.execute<{ day: string; tokens: number; messages: number }>(sql`
    select to_char(at at time zone 'Asia/Colombo', 'YYYY-MM-DD') as day,
      coalesce(sum(coalesce((quantity->>'input')::bigint, 0) + coalesce((quantity->>'output')::bigint, 0))
        filter (where kind = 'llm'), 0)::float8 as tokens,
      count(*) filter (where kind = 'action')::int as messages
    from usage_events
    where user_id = ${userId} and at >= ${from} and at < ${to}
      and ((kind = 'llm' and task = 'chat') or (kind = 'action' and task = 'chat.message'))
    group by 1 order by 1`);
  return r.rows;
}

/** Files in a case now. */
export async function caseFileCount(caseId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(caseFiles).where(eq(caseFiles.caseId, caseId));
  return r?.n ?? 0;
}

/** Bytes of the files a user owns now, in every workspace: stored, and pending uploads at their declared size. */
export async function ownedBytes(userId: string) {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${files.size}), 0)::float8` })
    .from(files)
    .where(and(eq(files.ownerId, userId), inArray(files.uploadState, ["pending", "stored"])));
  return r?.n ?? 0;
}

/** Who a case's cap is checked for: its author (null once they are deleted). */
export async function caseAuthor(caseId: string) {
  const [r] = await db.select({ createdBy: cases.createdBy }).from(cases).where(eq(cases.id, caseId));
  return r?.createdBy ?? null;
}

// ---- writes: platform staff (/admin) ----

export async function insertPlan(p: { key: string; name: string }) {
  const [r] = await db.insert(plans).values(p).returning();
  return r!;
}

export const renamePlan = (id: string, name: string) => db.update(plans).set({ name }).where(eq(plans.id, id));

/** Deletes a plan that is not the default; users on it fall back to the default (their user_plans rows go). */
export async function deletePlan(id: string) {
  const r = await db
    .delete(plans)
    .where(and(eq(plans.id, id), eq(plans.isDefault, false)))
    .returning({ id: plans.id });
  return r.length > 0;
}

/** Makes one plan the default, in one transaction (the partial unique index allows only one). */
export const setDefaultPlan = (id: string) =>
  db.transaction(async (tx) => {
    await tx.update(plans).set({ isDefault: false }).where(eq(plans.isDefault, true));
    await tx.update(plans).set({ isDefault: true }).where(eq(plans.id, id));
  });

/** Sets a plan's max for a metric; null removes it (unlimited). */
export async function setPlanLimit(planId: string, metric: string, max: number | null) {
  if (max == null) await db.delete(planLimits).where(and(eq(planLimits.planId, planId), eq(planLimits.metric, metric)));
  else
    await db
      .insert(planLimits)
      .values({ planId, metric, max })
      .onConflictDoUpdate({ target: [planLimits.planId, planLimits.metric], set: { max } });
}

export async function insertUserPlan(p: typeof userPlans.$inferInsert) {
  const [r] = await db.insert(userPlans).values(p).returning();
  return r!;
}

/** Ends a user's plan row now (it stays, for the history). */
export const endUserPlan = (id: string, userId: string, at = new Date()) =>
  db
    .update(userPlans)
    .set({ endsAt: at })
    .where(and(eq(userPlans.id, id), eq(userPlans.userId, userId)));

export const upsertUserLimit = (l: typeof userLimits.$inferInsert) =>
  db
    .insert(userLimits)
    .values(l)
    .onConflictDoUpdate({
      target: [userLimits.userId, userLimits.metric],
      set: { max: l.max, expiresAt: l.expiresAt, note: l.note, setBy: l.setBy, updatedAt: new Date() },
    });

export const deleteUserLimit = (userId: string, metric: string) =>
  db.delete(userLimits).where(and(eq(userLimits.userId, userId), eq(userLimits.metric, metric)));
