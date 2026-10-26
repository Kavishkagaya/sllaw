// One law tool call, exactly as the agent sees it (same ctx, same output shaping): for checking by hand.
//   pnpm --filter @sllaw/services -s tool search '{"query":"...","mode":"keyword","docKeys":["act:36/2024"]}'
import { lawTools } from "@sllaw/ai";
import { agentCtx } from "../src/agent";

const [name, input = "{}"] = process.argv.slice(2);
const tools: Record<string, any> = lawTools(
  agentCtx({ workspaceId: "dev", userId: "dev", asOfDate: process.env.AS_OF }),
);
if (!tools[name]) throw new Error(`tools: ${Object.keys(tools).join(", ")}`);
console.log(JSON.stringify(await tools[name].execute(JSON.parse(input), { toolCallId: "cli", messages: [] }), null, 1));
