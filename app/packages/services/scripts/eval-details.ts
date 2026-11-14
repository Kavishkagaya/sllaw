// Does the agent correct a file's details when a lawyer asks in plain words (docs/features/playbooks.json, d5)? On a
// case of the dev database: before each try the file's amount is set wrong, the main agent gets one plain request
// to fix it (a fresh chat each time, so a case chat's first turn), and the stored details are read back. Prints per
// try: corrected or not, whether it opened Document details, whether it claimed a change it did not make, cost.
//   CASE=<case id> FILE=<file id> pnpm --filter @sllaw/services eval-details [tries]
// The file must be a letter of demand whose document claims Rs. 510,000 (the Perera v. Silva test case's). Writes
// the file's details (in the agent's own database branch, docs/features/README.md); leaves them at Rs. 510,000.
import { mainAgent, mainTools, SourceMap } from "@sllaw/ai";
import { caseById, fileById } from "@sllaw/db";
import { type Metered, setUsageSink } from "@sllaw/usage";
import { agentCtx, caseFilesOf } from "../src/agent";
import { editCard } from "../src/files/card";
import { readOffice } from "../src/office";

const ASKS = [
  "The letter of demand claims Rs. 510,000 but its details say 51,000. Please fix that.",
  "The amount on the demand letter is wrong, it should be Rs. 510,000.",
  "Can you correct the demand's amount to Rs. 510,000? It shows 51,000.",
  "Our demand to Silva was for Rs. 510,000, not 51,000. Update it please.",
  "Fix the amount in the letter of demand: Rs. 510,000.",
];
const tries = Number(process.argv[2] ?? 10);
const c = await caseById(process.env.CASE ?? "");
const f = await fileById(process.env.FILE ?? "");
if (!c || !f) throw new Error("CASE and FILE: a case of the dev database and its letter of demand");

const calls: Metered[] = [];
setUsageSink(async (es) => void calls.push(...es.filter((e) => e.kind === "llm")));
const cost = () => calls.reduce((a, e) => a + Number(e.meta?.inferenceCost ?? 0), 0);

let ok = 0;
for (let i = 0; i < tries; i++) {
  await editCard(f, { fields: { amount: "Rs. 51,000" } }, null);
  const ctx = agentCtx({
    workspaceId: c.workspaceId,
    userId: c.createdBy,
    caseId: c.id,
    caseBrief: { title: c.title, facts: c.facts },
    caseFiles: await caseFilesOf(c.id),
    caseOffice: (await readOffice(c.id)).office,
  });
  const before = cost();
  const q = ASKS[i % ASKS.length]!;
  const r = await mainAgent(ctx, new SourceMap()).generate({ prompt: q });
  const used = r.steps.flatMap((s) => s.toolCalls);
  const opened = used.some(
    (t) => t.toolName === "playbook" && (t.input as { name: string }).name === "Document details",
  );
  // read back as stored now: the ctx above holds the files as they were before the turn
  const now = { ...ctx, caseFiles: await caseFilesOf(c.id) };
  const card = (await mainTools(now).fileCard.execute!({ files: [f.id] }, {
    toolCallId: "eval",
    messages: [],
    context: {},
  } as never)) as { cards?: { fields?: Record<string, unknown> }[] };
  const amount = String(card.cards?.[0]?.fields?.amount ?? "");
  const fixed = /510,?000/.test(amount);
  const claimed = /\b(corrected|updated|changed|fixed)\b/i.test(r.text);
  if (fixed) ok++;
  console.log(
    JSON.stringify({
      try: i + 1,
      q,
      fixed,
      amount,
      opened,
      falseClaim: !fixed && claimed,
      steps: r.steps.length,
      tools: used.map((t) => t.toolName).join(","),
      cost: +(cost() - before).toFixed(5),
      answer: r.text.slice(0, 200),
    }),
  );
}
await editCard(f, { fields: { amount: "Rs. 510,000" } }, null);
console.log(`corrected ${ok}/${tries}; cost $${cost().toFixed(4)}`);
process.exit(0);
