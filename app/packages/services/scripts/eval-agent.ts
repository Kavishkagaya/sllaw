// The research agent on the current-law questions of etl/eval_questions.json (status "current"; PIPELINE.md, gold
// set checked 2026-10-18). A hit: the gold chunk, or a chunk of the same law title and label (the other edition),
// is in the evidence pack. Prints per question (with the cited chunks), then the totals; each question's full trace
// (tool calls, results, pack) goes to $TRACE_DIR/<n>.json when TRACE_DIR is set.
//   TRACE_DIR=/tmp/traces pnpm --filter @sllaw/services eval-agent [n,n,...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runResearch } from "@sllaw/ai";
import { agentCtx } from "../src/research";

type Q = { id: number; doc: string; label: string; en: string; status: string };
const all: Q[] = JSON.parse(readFileSync(new URL("../../../../etl/eval_questions.json", import.meta.url), "utf8"));
const only = process.argv[2]?.split(",").map(Number);
const qs = all.map((q, i) => ({ ...q, n: i + 1 })).filter((q) => q.status === "current" && (!only || only.includes(q.n)));

const ctx = agentCtx({ workspaceId: "eval", userId: "eval" });
const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
const CONCURRENCY = 4;
const traceDir = process.env.TRACE_DIR;
if (traceDir) mkdirSync(traceDir, { recursive: true });

const rows: { n: number; hit: boolean; steps: number; inTok: number; cached: number; outTok: number; err?: string }[] = [];
const run = async (q: (typeof qs)[number]) => {
  try {
    const { pack, steps, usage } = await runResearch(ctx, q.en);
    const ids = pack?.evidence.map((e) => e.chunkId) ?? [];
    const read = await ctx.ports.read([q.id, ...ids]); // unordered (no ORDER BY): pick out by id
    const gold = read.find((c) => c.chunkId === q.id);
    const got = ids.map((id) => read.find((c) => c.chunkId === id)).filter((c) => c !== undefined);
    const hit = ids.includes(q.id) || got.some((c) => norm(c.title) === norm(gold?.title ?? null) && c.label === gold?.label);
    const r = { n: q.n, hit, steps: steps.length, inTok: usage.inputTokens ?? 0, cached: usage.inputTokenDetails?.cacheReadTokens ?? 0, outTok: usage.outputTokens ?? 0 };
    rows.push(r);
    console.log(`#${q.n} ${hit ? "HIT " : "MISS"} ${q.doc} s${q.label} | ${pack ? `${ids.length} chunks` : "no pack"} | steps ${r.steps} | in ${r.inTok} (cached ${r.cached}) out ${r.outTok}`);
    console.log(`   ${hit ? "" : `Q: ${q.en}\n   `}cited: ${got.map((c) => `${c.docKey} s${c.label}`).join(", ")}`);
    if (traceDir) writeFileSync(`${traceDir}/${q.n}.json`, JSON.stringify({ q, hit, usage, pack,
      steps: steps.map((s) => ({ text: s.text, calls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
        results: s.toolResults.map((r) => ({ tool: r.toolName, output: r.output })), usage: s.usage })) }, null, 1));
  } catch (e) {
    rows.push({ n: q.n, hit: false, steps: 0, inTok: 0, cached: 0, outTok: 0, err: String(e).slice(0, 200) });
    console.log(`#${q.n} ERROR ${String(e).slice(0, 200)}`);
  }
};
for (let i = 0; i < qs.length; i += CONCURRENCY) await Promise.all(qs.slice(i, i + CONCURRENCY).map(run));

const sum = (k: "inTok" | "cached" | "outTok" | "steps") => rows.reduce((a, r) => a + r[k], 0);
console.log(`\n${rows.filter((r) => r.hit).length}/${rows.length} hit | avg steps ${(sum("steps") / rows.length).toFixed(1)} | ` +
  `avg in ${Math.round(sum("inTok") / rows.length)} (cached ${Math.round(sum("cached") / rows.length)}) out ${Math.round(sum("outTok") / rows.length)}`);
