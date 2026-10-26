// Clerk webhook sync against the app database, with made-up Clerk ids; leaves nothing behind.
//   pnpm --filter @sllaw/services check-accounts
import assert from "node:assert/strict";
import type { WebhookEvent } from "@clerk/backend/webhooks";
import { accountOf, syncClerkEvent } from "../src/accounts";

const U = "user_check",
  O = "org_check";
const ev = (type: string, data: object) => syncClerkEvent({ type, data } as WebhookEvent);
const org = { id: O, name: "Check Chambers", slug: "check" };
const member = (role: string) => ({
  role,
  organization: org,
  public_user_data: { user_id: U, identifier: "a@b.lk", first_name: "A", last_name: "B", image_url: "" },
});

try {
  await ev("organizationMembership.created", member("org:admin")); // before user.created / organization.created
  await ev("user.created", {
    id: U,
    first_name: "Asha",
    last_name: "B",
    image_url: "",
    primary_email_address_id: "e1",
    email_addresses: [{ id: "e1", email_address: "asha@b.lk" }],
  });
  await ev("organizationMembership.updated", member("org:member"));
  const a = await accountOf(U, O);
  assert.equal(a?.user.email, "a@b.lk"); // the membership's copy came last
  assert.equal(a?.workspace?.name, "Check Chambers");
  assert.equal(a?.workspace?.role, "member");
  assert.notEqual(a?.user.id, U); // our id, not Clerk's
  assert.equal((await accountOf(U, null))?.workspace, null);

  await ev("organizationMembership.deleted", member("org:member"));
  assert.equal((await accountOf(U, O))?.workspaces.length, 0);
  console.log("ok");
} finally {
  await ev("organization.deleted", { id: O, deleted: true });
  await ev("user.deleted", { id: U, deleted: true });
  assert.equal(await accountOf(U, O), null);
}
