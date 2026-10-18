// The research agent (docs/APP.md, Knowledge): a cheap model, many tool calls, and an evidence pack back, not prose:
// the chunks that answer and why. It narrows the search; quoting and citing are the main agent's.
// The pack comes in as the input of a final `submit` tool, not as JSON output: tool arguments are structured on
// every provider, while JSON-schema output is not (the gateway's provider for deepseek-v4-flash has only JSON
// mode, and the model wrapped its JSON in a ```json fence, 2026-10-18).
import { stepCountIs, type StepResult, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { model } from "../models";
import type { Ctx } from "../ports";
import { researchTools } from "../tools/research";

export const evidencePack = z.object({
  evidence: z.array(
    z.object({
      chunkId: z.number().int(),
      why: z.string().describe("how it bears on the question, and whether it was amended or repealed by the question's date"),
    }),
  ),
  gaps: z.array(z.string()).describe("what the corpus did not answer"),
});
export type EvidencePack = z.infer<typeof evidencePack>;

// the date is the lawyer's (ctx.asOfDate), not the model's guess
const instructions = (asOfDate: string) => `You research Sri Lankan statute law for a lawyer, as the law stood on
${asOfDate}. You find the provisions that answer the question and say why each matters. You do not write the
answer: another agent quotes and cites from what you return.

# The law you search
Every document has a key; use keys only as they come back from search or links, never made up.
- constitution:N: the Constitution of 1978, the supreme law, as amended up to the Nth Amendment (17 to 21; the
  highest N is the newest). constitution is the 1978 text as enacted. Its parts are Articles (labelled like
  sections: 41A, 154G). An Act inconsistent with the Constitution gives way to it.
- amendment:N: the Nth Amendment to the Constitution (an amending Act).
- act:N/YYYY: Act No. N of YYYY, passed by Parliament (before 1972, and from 1978 on).
- law:N/YYYY: Law No. N of YYYY, passed by the National State Assembly (1972-1978). It is an Act in all but name.
- cap:N and cap1956:N: chapters of the Revised Editions, official consolidations of the older law (Ordinances
  and Acts) in force when they were made: cap1956:N the 1956 edition, cap:N the 1980 one. They are numbered
  differently, so the same law has a different N in each. The 1980 text replaces the 1956 one; use cap1956 only
  for a law the 1980 edition does not have. Changes after 1980 are in later Acts.
- A principal enactment is the law an amending Act changes ("the principal enactment" in that Act). The corpus
  holds each law as enacted (or as of its Revised Edition), not a merged current text: what a section says today
  is its text plus the changes made to it since, which asOf lists.

# Links between documents
amends, inserts, replaces, repeals: a section of one law changes a section of another. amends_act, repeals_act: a
law changes or repeals a whole law. cites: a provision refers to another. same_as: the same law in another edition
or text (a 1956 chapter and its 1980 chapter, a consolidated Constitution and the 1978 one). consolidates: a Revised
Edition chapter takes in an earlier law.

# Order of work
1. Restate the question in English (translate Sinhala or Tamil first) and note the date: ${asOfDate}.
2. Find the governing law: search in plain words, without docKeys. From the hits, pick the law or laws that
   govern the subject, by title and key. A question can need more than one law (a general Act and a special
   one, an Act and the Constitution).
3. Check that law is still in force on ${asOfDate}: links on the law, direction "in", kinds ["repeals_act"]. If
   a later law repealed it, go to that law and start step 3 again from there. For an old law, prefer its cap:N
   chapter (links same_as) over cap1956:N.
4. Find the sections inside that law: search with docKeys (mode "keyword" or "weighted" for a section number or
   a defined term). Read the hits that look right in full. Read too what they depend on: the definition of a key
   term (the interpretation section, usually near the end or in section 2), a proviso or exception, the penalty.
5. Check each section with asOf: a change in force by ${asOfDate} may have amended, replaced or repealed it.
   When it replaced or inserted words, read the amending chunk to see the new text.
6. Follow cites when a section rests on another provision ("subject to section 12", "Article 126"): read that
   one too.
7. Stop when the question is answered. Do not repeat a search that found nothing; a law with no text goes in gaps.
8. Call submit with the chunks you have read and why each matters (what it provides, and whether it was amended,
   replaced or repealed by ${asOfDate}), and in gaps what you could not find. If submit lists problems, fix them
   and call it again.

You may call several tools in one step when they do not depend on each other. You have ${MAX_STEPS} steps.`;

const MAX_STEPS = 15; // ponytail: fixed budget; per-question budget when the main agent plans sub-questions

/** Items whose chunk the agent never read in this run (seen only as a search snippet), by index. Editions are not
 *  checked: a title and label match does not prove two chunks are one law, and an answer may need both. */
export function packProblems(pack: EvidencePack, seen: Set<number>) {
  const out: { i: number; why: string }[] = [];
  pack.evidence.forEach((e, i) => {
    if (!seen.has(e.chunkId)) out.push({ i, why: `chunk ${e.chunkId} was not read: read it before you return it` });
  });
  return out;
}

const submitted = ({ steps }: { steps: StepResult<any>[] }) =>
  steps.at(-1)?.toolResults.some((r) => r.toolName === "submit" && (r.output as { ok?: boolean }).ok) ?? false;

export const researchAgent = (ctx: Ctx, seen = new Set<number>()) =>
  new ToolLoopAgent({
    model: model("research", ctx.workspaceId),
    instructions: instructions(ctx.asOfDate),
    tools: {
      ...researchTools(ctx, seen),
      submit: tool({
        description: "Hand in the evidence pack. Call it once, last; if it lists problems, fix them and call it again.",
        inputSchema: evidencePack,
        execute: async (pack) => {
          const problems = packProblems(pack, seen);
          return problems.length ? { ok: false, problems: problems.map((p) => p.why) } : { ok: true };
        },
      }),
    },
    stopWhen: [submitted, stepCountIs(MAX_STEPS)],
    // the last step must hand in what it has; only this request changes, so earlier steps stay cached
    prepareStep: ({ stepNumber }) =>
      stepNumber === MAX_STEPS - 1 ? { toolChoice: { type: "tool", toolName: "submit" } } : undefined,
  });

/** Run the agent; the pack is the last submit's input, less the items that failed the checks (null when the step
 *  budget ran out before any submit). */
export async function runResearch(ctx: Ctx, question: string) {
  const seen = new Set<number>();
  const r = await researchAgent(ctx, seen).generate({ prompt: question });
  const submit = r.steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === "submit").at(-1);
  let pack = (submit?.input as EvidencePack | undefined) ?? null;
  if (pack) {
    const bad = new Set(packProblems(pack, seen).map((p) => p.i));
    pack = { ...pack, evidence: pack.evidence.filter((_, i) => !bad.has(i)) };
  }
  return { pack, steps: r.steps, usage: r.totalUsage };
}
