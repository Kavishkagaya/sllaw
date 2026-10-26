// Users, workspaces and their members. Writes are upserts by clerk_id: Clerk webhooks arrive in any order and retry.
import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { users, workspaces, workspaceUsers } from "./schema";

export type UserFields = { clerkId: string; email: string | null; name: string | null; imageUrl: string | null };
export type WorkspaceFields = { clerkId: string; name: string; slug: string | null };

export async function upsertUser(u: UserFields) {
  const { clerkId, ...set } = u;
  const [row] = await db.insert(users).values(u).onConflictDoUpdate({ target: users.clerkId, set }).returning();
  return row!;
}

export async function upsertWorkspace(w: WorkspaceFields) {
  const { clerkId, ...set } = w;
  const [row] = await db
    .insert(workspaces)
    .values(w)
    .onConflictDoUpdate({ target: workspaces.clerkId, set })
    .returning();
  return row!;
}

export async function upsertWorkspaceUser(workspaceId: string, userId: string, role: string) {
  await db
    .insert(workspaceUsers)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({ target: [workspaceUsers.workspaceId, workspaceUsers.userId], set: { role } });
}

// deletes cascade to workspace_users (and a workspace's cases)
export const deleteUser = (clerkId: string) => db.delete(users).where(eq(users.clerkId, clerkId));
export const deleteWorkspace = (clerkId: string) => db.delete(workspaces).where(eq(workspaces.clerkId, clerkId));

export async function deleteWorkspaceUser(workspaceClerkId: string, userClerkId: string) {
  const [w] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.clerkId, workspaceClerkId));
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, userClerkId));
  if (w && u)
    await db.delete(workspaceUsers).where(and(eq(workspaceUsers.workspaceId, w.id), eq(workspaceUsers.userId, u.id)));
}

export async function userByClerkId(clerkId: string) {
  const [u] = await db.select().from(users).where(eq(users.clerkId, clerkId));
  return u ?? null;
}

/** The workspaces a user belongs to, with their role in each. */
export const workspacesOf = (userId: string) =>
  db
    .select({
      id: workspaces.id,
      clerkId: workspaces.clerkId,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceUsers.role,
    })
    .from(workspaceUsers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
    .where(eq(workspaceUsers.userId, userId));
