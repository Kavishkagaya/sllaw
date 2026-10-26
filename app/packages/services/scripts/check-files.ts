// File ingest against the real services (R2 sllaw-files, the files model, bge-m3, Zilliz `files`), with a made-up Clerk
// user and workspace and files generated here; leaves nothing behind. Runs the pipeline in this process (runFile), not
// as a Vercel Workflow: the workflow and the live status need `pnpm dev` and an upload from the browser.
//   pnpm --filter @sllaw/services check-files            (one model call and a few embeddings per file: a cent or so)
import assert from "node:assert/strict";
import type { WebhookEvent } from "@clerk/backend/webhooks";
import { fileById, setUploaded } from "@sllaw/db";
import { fileIndex } from "@sllaw/search";
import { accountOf, syncClerkEvent } from "../src/accounts";
import { appDeps, deleteFile, keys, openFile, runFile, type Signed, startUpload } from "../src/files";

const U = "user_check_files",
  O = "org_check_files";
const ev = (type: string, data: object) => syncClerkEvent({ type, data } as WebhookEvent);

/** A text PDF, one string per page (Helvetica: ASCII only). */
function pdf(pages: string[][]) {
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  const font = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const s = `BT /F1 11 Tf 14 TL 60 760 Td ${lines.map((l) => `(${l.replace(/[()\\]/g, "")}) Tj T*`).join(" ")} ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  for (const [i, o] of objs.entries()) {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const plaint = pdf([
  [
    "IN THE DISTRICT COURT OF COLOMBO",
    "Case No. DC Colombo 4521/RE",
    "",
    "Ananda Perera, No. 12, Galle Road, Colombo 03, PLAINTIFF",
    "Vs.",
    "Kamal Silva, No. 45, Temple Road, Nugegoda, DEFENDANT",
    "",
    "PLAINT",
    "1. The plaintiff is the owner and landlord of premises No. 12/1, Galle Road, Colombo 03.",
    "2. By a lease agreement dated 1 March 2021 the plaintiff let the premises to the defendant",
    "   at a monthly rent of Rs. 85,000 payable on or before the 5th day of each month.",
    "3. The defendant has failed to pay the rent for the months of January 2024 to June 2024.",
  ],
  [
    "4. The plaintiff by letter of demand dated 15 July 2024 required the defendant to pay the arrears",
    "   of rent amounting to Rs. 510,000 and to quit and deliver vacant possession of the premises.",
    "5. The defendant has neither paid the arrears nor quit the premises.",
    "6. The premises are not premises to which the Rent Act No. 7 of 1972 applies, as stated in",
    "   section 2 of that Act, and the plaintiff is entitled to eject the defendant.",
    "WHEREFORE the plaintiff prays for judgment against the defendant for:",
    "(a) ejectment of the defendant and all those holding under him from the premises;",
    "(b) Rs. 510,000 as arrears of rent and damages at Rs. 85,000 per month until possession;",
    "(c) costs and such other relief as the court shall seem meet.",
  ],
  [
    "Settled by: P. Fernando, Attorney-at-Law, Registered Attorney for the Plaintiff",
    "Dated at Colombo this 2nd day of September 2024.",
  ],
]);

const note = new TextEncoder().encode(
  "නඩු සටහන - DC Colombo 4521/RE\n\nකුලී හිඟ මුදල රු. 510,000. විත්තිකරු කමල් සිල්වා. ඊළඟ දිනය 2024 නොවැම්බර් 14.\n\n" +
    "Client notes: the defendant says he paid January rent in cash; ask the plaintiff for receipts.",
);

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const made: string[] = [];
let a: Signed | null = null;

try {
  await ev("organizationMembership.created", {
    role: "org:admin",
    organization: { id: O, name: "Check Files Chambers", slug: "check-files" },
    public_user_data: { user_id: U, identifier: "files@check.lk", first_name: "F", last_name: "C", image_url: "" },
  });
  await ev("user.created", {
    id: U,
    first_name: "F",
    last_name: "C",
    image_url: "",
    primary_email_address_id: "e1",
    email_addresses: [{ id: "e1", email_address: "files@check.lk" }],
  });
  const acc = await accountOf(U, O);
  assert.ok(acc?.workspace, "no workspace for the check user");
  a = acc as Signed;

  for (const [name, mime, bytes] of [
    ["plaint.pdf", "application/pdf", plaint],
    ["notes.txt", "text/plain", note],
  ] as const) {
    // 1. the row and a signed upload URL; 2. the bytes to R2 as the browser sends them
    const up = await startUpload(a, { name, mime, size: bytes.byteLength });
    made.push(up.fileId);
    assert.ok(up.uploadUrl, "no signed upload URL: is STORAGE=memory set?");
    const put = await fetch(up.uploadUrl, { method: "PUT", body: bytes, headers: up.headers });
    assert.equal(put.status, 200, `upload ${put.status}: ${await put.text()}`);
    // 3. finishUpload without the workflow: checked in the store, stored, then the steps here
    const head = await appDeps().store.head(keys.original(up.fileId));
    assert.equal(head?.size, bytes.byteLength);
    await setUploaded(up.fileId, "stored", head!.size);
    console.log(`\n${name}: uploaded ${bytes.byteLength} bytes (${ms()})`);

    const ran = await runFile(up.fileId, appDeps());
    const f = (await fileById(up.fileId))!;
    console.log(`  steps ${JSON.stringify(ran)} (${ms()})`);
    console.log(`  extract_by ${f.extractBy}, pages ${f.pages}, chunks ${f.chunks}, index_by ${f.indexBy}`);
    for (const s of ["extract", "categorize", "index"] as const)
      if (f[`${s}Error`]) console.log(`  ${s} error:`, f[`${s}Error`]);
    assert.deepEqual(ran, { extract: "done", categorize: "done", index: "done" });

    const view = (await openFile(a, up.fileId))!;
    console.log(`  category ${f.category}; meta ${JSON.stringify(f.meta)}`);
    console.log(`  summary: ${view.summary}`);
    const dl = await fetch(view.downloadUrl!);
    assert.equal(dl.status, 200, "signed download");
    assert.equal((await dl.arrayBuffer()).byteLength, bytes.byteLength);
  }

  // search: own scope finds them, another user's scope finds nothing (Zilliz shows new rows within a few seconds)
  const scope = { workspaceId: a.workspace.id, scopes: [`user:${a.user.id}`] };
  let hits: Awaited<ReturnType<ReturnType<typeof fileIndex>["search"]>> = [];
  for (let i = 0; i < 10 && !hits.length; i++) {
    hits = await fileIndex().search("arrears of rent and ejectment", scope);
    if (!hits.length) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(
    `\nsearch "arrears of rent and ejectment": ${hits.length} hits; top: page ${hits[0]?.page}, ${hits[0]?.score?.toFixed(3)}: ${hits[0]?.text.slice(0, 90)}…`,
  );
  assert.ok(hits.length > 0, "own files not found");
  const si = await fileIndex().search("කුලී හිඟ මුදල", scope);
  console.log(`search (Sinhala) "කුලී හිඟ මුදල": top file ${si[0]?.fileId === made[1] ? "notes.txt" : si[0]?.fileId}`);
  assert.equal((await fileIndex().search("arrears of rent", { ...scope, scopes: ["user:someone-else"] })).length, 0);
  console.log("another user's scope: 0 hits");
} finally {
  // delete through the service: vectors, blobs, row
  for (const id of made) {
    const r = a ? await deleteFile(a, id) : null;
    const left = await appDeps().store.head(keys.original(id));
    console.log(`delete ${id}: ${r}; original left in R2: ${!!left}`);
  }
  await ev("organization.deleted", { id: O, deleted: true });
  await ev("user.deleted", { id: U, deleted: true });
  console.log(`done (${ms()})`);
}
