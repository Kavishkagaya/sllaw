// One agent tool call, exactly as the agent sees it (same ctx, the same mapper: handles for ids, snippets for hits;
// a fresh id map each run, so ids are numbered from 1 and only real ids can be passed in): for checking by hand.
//   pnpm --filter @sllaw/services -s tool search '{"query":"...","mode":"keyword","docKeys":["act:36/2024"]}'
// With CASE=<case id> (dev database) the ctx is that case's, so the file tools reach its files; `prompt` prints the
// whole system prompt the agent gets (the case's sections included):
//   CASE=<id> pnpm --filter @sllaw/services -s tool prompt
//   CASE=<id> pnpm --filter @sllaw/services -s tool fileSearch '{"query":"rent arrears"}'
//   CASE=<id> pnpm --filter @sllaw/services -s tool fileRead '{"file":"f1","pages":"1-2"}'  (f1: the first file fileCard lists)
// RAW=1 runs the tool itself, in real ids and full text.
import { mainPrompt, mainTools, SourceMap, wrapTools } from "@sllaw/ai";
import { caseById } from "@sllaw/db";
import { agentCtx, caseFilesOf } from "../src/agent";

const [name, input = "{}"] = process.argv.slice(2);
const c = process.env.CASE ? await caseById(process.env.CASE) : null;
if (process.env.CASE && !c) throw new Error(`no case ${process.env.CASE}`);
const ctx = agentCtx({
  workspaceId: c?.workspaceId ?? "dev",
  userId: c?.createdBy ?? "dev",
  caseId: c?.id ?? null,
  caseBrief: c && { title: c.title, facts: c.facts },
  caseFiles: c ? await caseFilesOf(c.id) : [],
  asOfDate: process.env.AS_OF,
});
const map = new SourceMap();
if (name === "prompt") {
  console.log(mainPrompt(ctx, map));
  process.exit(0);
}
// fileRead by file needs its handle: list the files first, as the agent would
if (!process.env.RAW && ctx.caseFiles.length) for (const f of ctx.caseFiles) map.handle("f", f.id, f.title ?? f.name);
const tools: Record<string, any> = process.env.RAW ? mainTools(ctx) : wrapTools(mainTools(ctx), map);
if (!tools[name]) throw new Error(`tools: prompt, ${Object.keys(tools).join(", ")}`);
console.log(
  JSON.stringify(
    await tools[name].execute(JSON.parse(input), { toolCallId: "cli", messages: [], context: {} }),
    null,
    1,
  ),
);
