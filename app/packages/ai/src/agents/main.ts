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
import type { CaseFile, Ctx } from "../ports";
import { ChunkCache } from "../sources/cache";
import { SourceMap, type SourcesJson } from "../sources/map";
import { realStream } from "../sources/stream";
import { partsToModel, partsToReal, wrapTools } from "../sources/wrap";
import { fileName, fileTools } from "../tools/files";
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
- Cite inline. Right after every statement of law, cite the provision it rests on as [[id]]: the id of a chunk you
  read or asOf'd exactly as the tool gave it, e.g. [[s4]]; the app shows the provision's name, so write no label.
  One provision per citation; for two, write [[s4]][[s9]]. A search hit is only its first lines: read it before you
  cite or quote it. Never cite an id you did not read or asOf (an amending section asOf showed counts), and never
  make one up. Say what the corpus did not answer rather than filling it from memory; general knowledge is said as
  such and not cited.

Answer in the language of the question; search in English. You may call several tools in one step when they do
not depend on each other. You have ${MAX_STEPS} steps.
Earlier turns' reads are still in the chat: reuse them.`;

/** A case chat's instructions end with the case (last, so the shared part above stays in the provider's cache): its
 *  facts, then how to use its files. The files themselves are not listed: the agent finds them by search and asks for
 *  a file's card when it needs one, so the instructions stay the same size however many files the case has. */
const FACTS = 6000; // chars of the facts kept: a case brief, not its files
const NOT_READY = 10; // files named in the instructions as not searchable; beyond, only counted

export function caseSection(c: Ctx["caseBrief"], files: CaseFile[], map = new SourceMap()) {
  if (!c) return "";
  const facts = c.facts.trim() ? c.facts.trim().slice(0, FACTS) : "(none written yet: ask for the facts that matter)";
  const waiting = files.filter((f) => !f.searchable);
  const named = waiting
    .slice(0, NOT_READY)
    .map(
      (f) =>
        `- ${map.handle("f", f.id, fileName(f))}  ${fileName(f)}: ${f.state === "processing" ? "still being read" : f.state === "unreadable" ? "no readable text" : "not indexed yet, read its pages with fileRead"}`,
    );
  if (waiting.length > NOT_READY) named.push(`- and ${waiting.length - NOT_READY} more`);
  const count = !files.length
    ? "The case has no files yet (the lawyer adds them in its Files tab): do not use the file tools."
    : `The lawyer has added ${files.length} file${files.length === 1 ? "" : "s"} to this case. You do not see them until you look.${
        named.length ? `\nNot searchable yet:\n${named.join("\n")}` : ""
      }`;
  return `

# The case
This chat is inside the lawyer's case "${c.title}". Read every question in its light: research the law that governs
these facts, and say which facts the answer turns on and which are missing. The facts as the lawyer wrote them:
${facts}

# The case files
${count}
The files are the facts as the parties, witnesses and courts put them; the corpus is the law. A document shows what
its author says, not that it is true: say whose document a fact comes from.
- fileSearch finds passages in the files (the passage's id, its file, page and first lines). Search them before
  asking the lawyer for a fact, and say where they contradict the facts above or each other.
- fileCard says what a file is (type, parties, dates, court, case numbers, laws cited, a summary); with no input it
  lists every file. Use it to know whose document a passage is before you rely on it, or to see what the case holds.
- fileRead reads passages in full, by id (from fileSearch), or a file's pages. Read the passages a point rests on
  before you state or quote it.
- A question about the files alone (what the plaint claims, a timeline of the events) is answered from them; no law
  research unless it asks for the law.
- Cite a file right after what it supports as [[id]]: the id of a passage you read with fileRead, e.g. [[c7]]; no
  label (the app shows the file and page). One passage per citation. A search snippet or a card is not a passage
  you read: never cite one.
- Before you write, list the passages you will rely on. Any you have not read with fileRead: read them in one call
  (fileRead takes several ids), or leave them out and say so in the gaps.`;
}

const LAST = `

# This is your last step
No tools are left. Write the answer now from what you have read, cited as above; what you did not get to check goes
in the answer as gaps. Do not write tool calls.`;

/** Every tool, in real ids, so a chat's stored messages validate whichever kind of chat it is; a plain chat is
 *  offered only the law tools (activeTools below). */
export const mainTools = (ctx: Ctx) => ({ ...lawTools(ctx), ...fileTools(ctx) });
const LAW_TOOLS = ["search", "read", "links", "asOf"] as const;

/** The agent of one turn: the model's tools are mainTools behind the mapper (handles for ids, snippets for hits). */
export const mainAgent = (ctx: Ctx, map = new SourceMap(), cache = new ChunkCache()) => {
  const base = instructions(ctx.asOfDate) + caseSection(ctx.caseBrief, ctx.caseFiles, map);
  return new ToolLoopAgent({
    model: model("main", ctx.workspaceId),
    instructions: base,
    tools: wrapTools(mainTools(ctx), map, cache),
    activeTools: ctx.caseId ? undefined : [...LAW_TOOLS],
    stopWhen: stepCountIs(MAX_STEPS),
    // the last step answers with what it has: no tools sent at all, since DeepSeek ignored toolChoice "none" alone
    // and spent the last step on more calls, leaving no answer (chat of 2026-10-18: 14 steps, no text)
    // and told so: without it the model wrote its next tool calls as text (<｜DSML｜ calls>…) as the answer (eval-chat 2026-10-20, #10)
    prepareStep: ({ stepNumber }) =>
      stepNumber === MAX_STEPS - 1
        ? {
            activeTools: [],
            toolChoice: "none",
            instructions: base + LAST,
          }
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
