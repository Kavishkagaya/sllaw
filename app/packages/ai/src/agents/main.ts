// The main agent (docs/APP.md, Knowledge): talks to the lawyer and does its own research with the corpus tools
// (search, read, links, asOf), then answers citing inline as [[s3]] only chunks it read or asOf'd. In a case chat it
// also has the case's files (fileSearch, fileCard, fileRead) and cites a passage it read as [[c7]]. The model sees
// only handles (sources/): the tools work in real ids, the database and the client get real ids and labels
// ([[81234|s. 22, Rent Act]]), so the UI can check every citation against the reads in the chat. One agent, not
// research sub-agents: on the eval they repeated each other's work on the same law and ran out of steps (PIPELINE.md,
// eval-chat 2026-10-18).
import {
  createAgentUIStream,
  createUIMessageStreamResponse,
  type InferAgentUIMessage,
  stepCountIs,
  ToolLoopAgent,
  validateUIMessages,
} from "ai";
import { model } from "../models";
import type { Ctx } from "../ports";
import { buildPrompt, buildTools } from "../prompt/build";
import { ChunkCache } from "../sources/cache";
import { SourceMap, type SourcesJson } from "../sources/map";
import { realStream } from "../sources/stream";
import { partsToModel, partsToReal, wrapTools } from "../sources/wrap";
import { mainSetup } from "./main.setup";

const MAX_STEPS = 20; // fixed budget; the last step must answer (14 until 2026-10-27: a case question used all 14)

/** The main agent's prompt for a turn (main.setup.ts): the law sections, the case's when in a case chat, the last
 *  step's note when last. */
export const mainPrompt = (ctx: Ctx, map = new SourceMap(), last = false) =>
  buildPrompt(mainSetup.sections, { ctx, map, maxSteps: MAX_STEPS, last });

/** The tools this chat may use, in real ids: the law tools, and the file tools in a case chat. A chat's stored
 *  messages still validate: a plain chat only ever had the law tools, and a chat moves only into a case. */
export const mainTools = (ctx: Ctx) => buildTools(mainSetup.tools, ctx);

/** The agent of one turn: the model's tools are mainTools behind the mapper (handles for ids, snippets for hits). */
export const mainAgent = (ctx: Ctx, map = new SourceMap(), cache = new ChunkCache()) => {
  const base = mainPrompt(ctx, map);
  return new ToolLoopAgent({
    model: model("main", ctx.workspaceId),
    instructions: base,
    tools: wrapTools(mainTools(ctx), map, cache),
    stopWhen: stepCountIs(MAX_STEPS),
    // the last step answers with what it has: no tools sent at all, since DeepSeek ignored toolChoice "none" alone
    // and spent the last step on more calls, leaving no answer (chat of 2026-10-18: 14 steps, no text)
    // and told so: without it the model wrote its next tool calls as text (<｜DSML｜ calls>…) as the answer (eval-chat 2026-10-20, #10)
    prepareStep: ({ stepNumber }) =>
      stepNumber === MAX_STEPS - 1
        ? { activeTools: [], toolChoice: "none", instructions: mainPrompt(ctx, map, true) }
        : undefined,
  });
};

export type ChatMessage = InferAgentUIMessage<ReturnType<typeof mainAgent>>;

/** What one assistant message cost, summed over its steps from the gateway's providerMetadata. cost is inference,
 *  gatewayCost what is billed (inference + surcharges such as the reporting tag); generations are the gateway's ids,
 *  for its per-call detail. */
export type Usage = {
  model: string;
  providers: string[];
  steps: number;
  input: number; // all input tokens
  cached: number; // of which read from the provider's cache
  output: number; // reasoning included
  reasoning: number;
  cost: number;
  gatewayCost: number;
  ms: number;
  generations: string[];
};

type Stored = { parts?: { type: string }[] };

/** Run the main agent over a chat's messages (history + the new user message, real ids, as stored) and its id map
 *  (chats.sources) as a UI message stream response in real ids. onFinish gets the assistant message to store (real
 *  ids), whole or as far as it got when abortSignal fired (the request's: the stop button, a closed tab or a lost
 *  connection all end the run), and the id map to store with it. */
export async function streamChat(
  ctx: Ctx,
  messages: unknown[],
  sources: SourcesJson | null,
  onFinish: (m: ChatMessage, usage: Usage, sources: SourcesJson) => Promise<void> | void,
  abortSignal?: AbortSignal,
) {
  const t0 = Date.now();
  const usage: Usage = {
    model: "",
    providers: [],
    steps: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    gatewayCost: 0,
    ms: 0,
    generations: [],
  };
  const map = new SourceMap(sources);
  const agent = mainAgent(ctx, map);
  // the history as the model saw it: the same handles as before (the map is the chat's), so the prompt cache holds
  const history = (messages as Stored[]).map((m) => (m.parts ? { ...m, parts: partsToModel(m.parts, map) } : m));
  const uiMessages = await validateUIMessages<ChatMessage>({ messages: history, tools: agent.tools });
  const stream = await createAgentUIStream({
    agent,
    uiMessages,
    originalMessages: uiMessages,
    abortSignal,
    generateMessageId: () => crypto.randomUUID(),
    // ponytail: a step cut off by the stop button reports no usage, so a stopped turn undercounts by that step
    onStepEnd: (step) => {
      const g = (step.providerMetadata?.gateway ?? {}) as {
        cost?: string;
        gatewayCost?: string;
        generationId?: string;
        routing?: { finalProvider?: string };
      };
      usage.model = step.model.modelId;
      usage.steps++;
      usage.input += step.usage.inputTokens ?? 0;
      usage.cached += step.usage.inputTokenDetails.cacheReadTokens ?? 0;
      usage.output += step.usage.outputTokens ?? 0;
      usage.reasoning += step.usage.outputTokenDetails.reasoningTokens ?? 0;
      usage.cost += Number(g.cost ?? 0);
      usage.gatewayCost += Number(g.gatewayCost ?? g.cost ?? 0);
      if (g.generationId) usage.generations.push(g.generationId);
      const p = g.routing?.finalProvider;
      if (p && !usage.providers.includes(p)) usage.providers.push(p);
    },
    onFinish: ({ responseMessage }) =>
      onFinish(
        { ...responseMessage, parts: partsToReal(responseMessage.parts, map) },
        { ...usage, ms: Date.now() - t0 },
        map.toJSON(),
      ),
  });
  return createUIMessageStreamResponse({ stream: stream.pipeThrough(realStream(map)) });
}
