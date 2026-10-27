// The main agent (what the chat runs) on a few questions: whether its answer cites the gold section, citations of
// chunks it never read, steps, model calls, tokens and cost per question.
//   pnpm --filter @sllaw/services eval-chat dl,6,7,13,19     (numbers: etl/eval_questions.json; dl: driving licence)
// TRACE_DIR=<dir> writes each question's tool calls and answer to <dir>/<n>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Call, mainAgent, recordCalls, SourceMap } from "@sllaw/ai";
import { agentCtx } from "../src/agent";

type Q = { n: string; doc?: string; label?: string; id?: number; en: string };
const gold: { id: number; doc: string; label: string; en: string }[] = JSON.parse(
  readFileSync(new URL("../../../../etl/eval_questions.json", import.meta.url), "utf8"),
);
const extra: Record<string, Q> = {
  dl: { n: "dl", en: "What is the procedure for get a driving license" },
  // a section over several chunks: the limits that matter (15(7), 15(8)) are in Art. 15's "(cont.)" chunks (chat 2026-10-20)
  fx: {
    n: "fx",
    doc: "constitution:21",
    label: "15",
    en: "Which Article of the Constitution protects freedom of expression, and what limits it?",
  },
};
const arg = process.argv[2] ?? "dl";
// "current": every question whose law is still in force (status "current"), as eval-agent runs them
const pick =
  arg === "current"
    ? gold.flatMap((q, i) => ((q as { status?: string }).status === "current" ? [String(i + 1)] : []))
    : arg.split(",");
const qs: Q[] = pick.map((k) => extra[k] ?? { n: k, ...gold[Number(k) - 1]! });
const traceDir = process.env.TRACE_DIR;
if (traceDir) mkdirSync(traceDir, { recursive: true });

const calls: Call[] = [];
recordCalls((c) => calls.push(c));
// the model cites handles ([[s3]], [[s3,s9]]) and its tool results carry them: the chat's map gives the real ids
const CITE = /\[\[([a-z]\d+(?:\s*[,;]\s*[a-z]\d+)*)\]\]/g;
const SEEN = new Set(["read", "asOf"]); // tools whose output is chunks the agent has read

const rows: Record<string, number | string | boolean>[] = [];
const one = async (q: Q) => {
  const ws = `eval-${q.n}`;
  const ctx = agentCtx({ workspaceId: ws, userId: "eval" });
  const t0 = Date.now();
  try {
    const map = new SourceMap();
    const r = await mainAgent(ctx, map).generate({ prompt: q.en });
    const real = (h: unknown) => (typeof h === "string" ? map.get(h, "s")?.real : undefined) as number | undefined;
    const seen = new Set<number>();
    const collect = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(collect);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const id = real(o.chunkId);
        if (id != null) seen.add(id);
        const by = real(o.byChunk);
        if (by != null && typeof o.clause === "string") seen.add(by); // amending section shown in asOf
        Object.values(o).forEach(collect);
      }
    };
    for (const s of r.steps) for (const t of s.toolResults) if (SEEN.has(t.toolName)) collect(t.output);
    const handles = [...r.text.matchAll(CITE)].flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
    const cited = [...new Set(handles.flatMap((h) => real(h) ?? []))];
    // gold by law + label, not chunk id: a rebuild renumbers chunks (the ids in eval_questions.json are pre-rebuild)
    const got = await ctx.ports.read(cited);
    const hit = q.doc ? got.some((c) => c.docKey === q.doc && c.label === q.label) : "-";
    const mine = calls.filter((c) => c.workspaceId === ws);
    const cost = mine.reduce((a, c) => a + Number((c.gateway as { cost?: unknown } | undefined)?.cost ?? NaN), 0);
    const row = {
      q: q.n,
      hit,
      cited: cited.length,
      unread: cited.filter((id) => !seen.has(id)).length,
      unreadIds: cited.filter((id) => !seen.has(id)).join(" "),
      steps: r.steps.length,
      calls: mine.length,
      input: mine.reduce((a, c) => a + c.input, 0),
      cached: mine.reduce((a, c) => a + c.cached, 0),
      cacheRate: `${Math.round((100 * mine.reduce((a, c) => a + c.cached, 0)) / Math.max(1, mine.reduce((a, c) => a + c.input, 0)))}%`,
      output: mine.reduce((a, c) => a + c.output, 0),
      cost: Number.isNaN(cost) ? "?" : cost.toFixed(4),
      secs: Math.round((Date.now() - t0) / 1000),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (traceDir)
      writeFileSync(
        `${traceDir}/${q.n}.json`,
        JSON.stringify(
          {
            q,
            row,
            text: r.text,
            gateway: mine[0]?.gateway,
            steps: r.steps.map((s) => ({
              calls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
              results: s.toolResults.map((t) => ({ tool: t.toolName, output: t.output })),
            })),
          },
          null,
          1,
        ),
      );
  } catch (e) {
    console.log(JSON.stringify({ q: q.n, error: String(e).slice(0, 300) }));
  }
};
const CONCURRENCY = 5;
for (let i = 0; i < qs.length; i += CONCURRENCY) await Promise.all(qs.slice(i, i + CONCURRENCY).map(one));
const sum = (k: string) =>
  rows.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : Number(r[k]) || 0), 0);
console.log(
  `\n${rows.length} questions | hits ${rows.filter((r) => r.hit === true).length}/${rows.filter((r) => r.hit !== "-").length} | ` +
    `unread cites ${sum("unread")} | calls ${sum("calls")} | input ${sum("input")} (cached ${sum("cached")}, ${Math.round((100 * sum("cached")) / Math.max(1, sum("input")))}%) output ${sum("output")} | cost $${sum("cost").toFixed(4)} | slowest ${Math.max(...rows.map((r) => r.secs as number))} s`,
);
