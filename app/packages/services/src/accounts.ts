// Users and workspaces are ours (uuid); Clerk is only where they sign in. The Clerk webhook keeps users, workspaces
// and workspace_users in step; everything else in the app refers to our ids.
import type { WebhookEvent } from "@clerk/backend/webhooks";
import {
  deleteUser,
  deleteWorkspace,
  deleteWorkspaceUser,
  upsertUser,
  upsertWorkspace,
  upsertWorkspaceUser,
  userByClerkId,
  workspacesOf,
} from "@sllaw/db";

const fullName = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(" ") || null;
const role = (clerkRole: string) => clerkRole.replace(/^org:/, ""); // org:admin -> admin

/** Apply one Clerk webhook event. A membership event carries its organization and user, so it upserts both:
 *  nothing depends on user.created or organization.created arriving first. */
export async function syncClerkEvent(evt: WebhookEvent) {
  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const u = evt.data;
      const email = u.email_addresses.find((e) => e.id === u.primary_email_address_id)?.email_address ?? null;
      await upsertUser({ clerkId: u.id, email, name: fullName(u.first_name, u.last_name), imageUrl: u.image_url });
      break;
    }
    case "user.deleted":
      if (evt.data.id) await deleteUser(evt.data.id);
      break;
    case "organization.created":
    case "organization.updated":
      await upsertWorkspace({ clerkId: evt.data.id, name: evt.data.name, slug: evt.data.slug });
      break;
    case "organization.deleted":
      if (evt.data.id) await deleteWorkspace(evt.data.id);
      break;
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const { organization: o, public_user_data: p } = evt.data;
      const w = await upsertWorkspace({ clerkId: o.id, name: o.name, slug: o.slug });
      // ponytail: on a user who already exists this rewrites email/name from the membership's copy; same data in Clerk
      const u = await upsertUser({
        clerkId: p.user_id,
        email: p.identifier,
        name: fullName(p.first_name, p.last_name),
        imageUrl: p.image_url,
      });
      await upsertWorkspaceUser(w.id, u.id, role(evt.data.role));
      break;
    }
    case "organizationMembership.deleted":
      await deleteWorkspaceUser(evt.data.organization.id, evt.data.public_user_data.user_id);
      break;
  }
}

export type Account = NonNullable<Awaited<ReturnType<typeof accountOf>>>;

/** The signed-in user with their workspaces and the active one (Clerk's active organization), by our ids.
 *  null when the webhook has not synced this user yet. */
export async function accountOf(clerkUserId: string, clerkOrgId: string | null) {
  const user = await userByClerkId(clerkUserId);
  if (!user) return null;
  const workspaces = await workspacesOf(user.id);
  const workspace = workspaces.find((w) => w.clerkId === clerkOrgId) ?? null;
  return { user, workspaces, workspace };
}
