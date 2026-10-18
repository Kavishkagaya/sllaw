// One question through the research agent: its tool calls, then the evidence pack.
//   pnpm --filter @sllaw/services research "Do I need permission to build a new power generation plant?"
import { runResearch } from "@sllaw/ai";
import { agentCtx } from "../src/research";

const question = process.argv[2];
if (!question) throw new Error("usage: research <question>");
const { pack, steps, usage } = await runResearch(agentCtx({ workspaceId: "dev", userId: "dev" }), question);
for (const s of steps) for (const c of s.toolCalls) if (c.toolName !== "submit") console.log("→", c.toolName, JSON.stringify(c.input));
console.log(JSON.stringify(pack, null, 2));
console.log(`steps ${steps.length}, tokens in ${usage.inputTokens} (cached ${usage.inputTokenDetails?.cacheReadTokens}) out ${usage.outputTokens}`);
