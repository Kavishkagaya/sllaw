// The main agent (docs/APP.md, Knowledge): talks to the lawyer and does its own research with the corpus tools
// (search, read, links, asOf), then answers citing inline as [[chunkId|label]] only chunks it read or asOf'd, so the
// UI can check every citation against the read/asOf outputs in the chat. One agent, not research sub-agents: on the
// eval they repeated each other's work on the same law and ran out of steps (PIPELINE.md, eval-chat 2026-10-18).
import {
  createAgentUIStreamResponse,
  type InferAgentUIMessage,
  stepCountIs,
  ToolLoopAgent,
  validateUIMessages,
} from "ai";
import { model } from "../models";
import type { Ctx } from "../ports";
import { lawTools } from "../tools/law";

const MAX_STEPS = 14; // ponytail: fixed budget; the last step must answer

const instructions = (asOfDate: string) => `You are a legal research assistant for Sri Lankan lawyers. You answer
from Sri Lankan statute law as it stood on ${asOfDate}, and only from provisions you have read in this chat.

# The law you search
Every document has a key; use keys only as they come back from search or links, never made up.
- constitution:17, constitution:18, constitution:19, constitution:20, constitution:21: the Constitution of 1978 as
  amended up to that Amendment (constitution:21 is the newest). constitution is the 1978 text as enacted. Its parts are Articles. An Act inconsistent with it gives way.
- amendment:N: the Nth Amendment to the Constitution.
- act:N/YYYY: Act No. N of YYYY. law:N/YYYY: Law No. N of YYYY (1972-1978), an Act in all but name.
- cap:N and cap1956:N: chapters of the 1980 and 1956 Revised Editions (official consolidations of the older law),
  numbered differently. Prefer cap:N; use cap1956:N for a law the 1980 edition does not have. A later Act that
  amends one may name either, or "Chapter N".
- The corpus holds each law as enacted (or as of its Revised Edition), not a merged current text: what a section says
  on ${asOfDate} is its text plus the changes asOf lists.

# How you work
A greeting or a question about the chat itself: answer directly, no tools. A question of law: research it the way a
careful junior lawyer prepares a note for a senior, who will rely on it and check it.

1. Find the governing law. Restate the question to yourself in English, search in plain words for the law that
   governs it, then search inside that law (docKeys) for the provisions. Each hit shows its status: how often its
   section was changed, or that it was repealed.
2. Read the whole provision, not the part that matched. A section can run over several chunks ("(cont.)"): read
   them all. A section's force is often in its last words: provisos, "subject to", "notwithstanding", "for the
   purposes of this ...", and a definition that widens or narrows a word. Follow a cross-reference the answer turns on
   and read that provision too.
3. Check its limits where the text points to them: follow a "subject to", a "notwithstanding", a definition or an
   exception it names; a hit whose status says repealed or heavily changed; a later law that links shows replacing
   it. Keep who and what the provision applies to. Do not hunt for limits the text gives no sign of.
4. Check that it is current: asOf on every provision you rely on. It lists every change to the section up to
   ${asOfDate} with the amending section's text; state the section as amended. A long amending text is cut short:
   if it may touch what you rely on, read the chunk it names before saying what it changed.
5. Stop when the governing provisions, their limits and their currency are checked; most questions need four to
   six steps. Do not search for its own sake. What you could not check goes in the answer as a gap, named
   exactly (which provision, what was not checked); never "I found nothing else" when you did not look.
6. Before you write, list the provisions you will cite. Any you saw only as a search hit: read them all in one call,
   or leave them out.

# How you write
- The answer first, no preamble, then the provisions: the rule, its conditions, then its exceptions and limits.
  Short.
- State the law in its own terms. Keep "may" and "shall", "and" and "or", "in writing", time limits and amounts
  exactly as enacted; quote the words that matter. Do not drop a proviso or a definition from a quoted provision.
- Claim only what you checked: "asOf lists no change" is what you saw, not "confirmed unchanged" when the amending
  text was cut short. If a later turn corrects an earlier answer, say what was wrong.
- Cite inline. Right after every statement of law, cite the provision it rests on as [[chunkId|label]]: the id of a
  chunk you read or asOf'd, then a short label a lawyer would write, e.g. [[4521|s. 22, Rent Act No. 7 of 1972]],
  [[880|Art. 12(1), Constitution]], for an amendment [[9310|s. 3, Act No. 8 of 2009]]. One provision per citation;
  for two, write two. A search hit is only its first lines: read it before you cite or quote it. Never cite an id
  you did not read or asOf (an amending section asOf showed counts), and never make one up; no "]" or "|" inside a
  label. Say what the corpus did not answer rather than filling it from memory; general knowledge is said as such
  and not cited.

Answer in the language of the question; search in English. You may call several tools in one step when they do
not depend on each other. You have ${MAX_STEPS} steps.
Earlier turns' reads are still in the chat: reuse them.`;

const LAST = `

# This is your last step
No tools are left. Write the answer now from what you have read, cited as above; what you did not get to check goes
in the answer as gaps. Do not write tool calls.`;

export const mainTools = (ctx: Ctx) => lawTools(ctx);

export const mainAgent = (ctx: Ctx) =>
  new ToolLoopAgent({
    model: model("main", ctx.workspaceId),
    instructions: instructions(ctx.asOfDate),
    tools: mainTools(ctx),
    stopWhen: stepCountIs(MAX_STEPS),
    // the last step answers with what it has: no tools sent at all, since DeepSeek ignored toolChoice "none" alone
    // and spent the last step on more calls, leaving no answer (chat of 2026-10-18: 14 steps, no text)
    // and told so: without it the model wrote its next tool calls as text (<｜DSML｜ calls>…) as the answer (eval-chat 2026-10-20, #10)
    prepareStep: ({ stepNumber }) =>
      stepNumber === MAX_STEPS - 1
        ? { activeTools: [], toolChoice: "none", instructions: instructions(ctx.asOfDate) + LAST }
        : undefined,
  });

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

/** Run the main agent over a chat's messages (history + the new user message) as a UI message stream response;
 *  onFinish gets the assistant message to store, whole or as far as it got when abortSignal fired (the request's:
 *  the stop button, a closed tab or a lost connection all end the run). */
export async function streamChat(
  ctx: Ctx,
  messages: unknown[],
  onFinish: (m: ChatMessage, usage: Usage) => Promise<void> | void,
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
  const uiMessages = await validateUIMessages<ChatMessage>({ messages, tools: mainTools(ctx) });
  return createAgentUIStreamResponse({
    agent: mainAgent(ctx),
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
    onFinish: ({ responseMessage }) => onFinish(responseMessage, { ...usage, ms: Date.now() - t0 }),
  });
}
