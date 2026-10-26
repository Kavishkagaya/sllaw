// Cases against the app database (and R2 + Zilliz for the one file's delete), with a made-up account; leaves
// nothing behind.
//   pnpm --filter @sllaw/services check-cases
import assert from "node:assert/strict";
import type { WebhookEvent } from "@clerk/backend/webhooks";
import { accountOf, syncClerkEvent } from "../src/accounts";
import { addCaseFile, createCase, deleteCase, listCaseFiles, listCases, openCase, updateCase } from "../src/cases";
import type { Signed } from "../src/files";

const U = "user_check_cases",
  O = "org_check_cases";
const ev = (type: string, data: object) => syncClerkEvent({ type, data } as WebhookEvent);
const org = { id: O, name: "Check Cases", slug: "check-cases" };

try {
  await ev("organizationMembership.created", {
    role: "org:admin",
    organization: org,
    public_user_data: { user_id: U, identifier: "c@b.lk", first_name: "C", last_name: "B", image_url: "" },
  });
  const a = (await accountOf(U, O)) as Signed;
  assert.ok(a?.workspace);

  const c = await createCase(a, { title: "Perera v. Silva", facts: "A lease of 2019. ".repeat(40) });
  let list = await listCases(a);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.files, 0);
  assert.equal(list[0]!.facts.length, 280); // the start of the facts only

  assert.deepEqual(await updateCase(a, c.id, { title: "Perera v. Silva (DC Colombo)", facts: "short" }), { id: c.id });
  assert.equal((await openCase(a, c.id))?.title, "Perera v. Silva (DC Colombo)");

  // a file whose bytes never came: listed, still processing; counted on the card
  const up = await addCaseFile(a, c.id, { name: "plaint.pdf", mime: "application/pdf", size: 1000 });
  assert.ok(up);
  const files = await listCaseFiles(a, c.id);
  assert.equal(files?.length, 1);
  assert.equal(files![0]!.group, "Processing");
  list = await listCases(a);
  assert.equal(list[0]!.files, 1);
  assert.ok(list[0]!.lastFileAt instanceof Date);

  // a case the user cannot see reads as missing
  const other = { ...a, user: { ...a.user, id: crypto.randomUUID() } };
  assert.equal(await openCase(other, c.id), null);
  assert.equal(await deleteCase(other, c.id), null);

  assert.equal(await deleteCase(a, c.id), "removed");
  assert.equal(await openCase(a, c.id), null);
  assert.equal((await listCases(a)).length, 0);
  console.log("ok");
} finally {
  await ev("organization.deleted", { id: O, deleted: true }); // cascades to any case left
  await ev("user.deleted", { id: U, deleted: true });
}
