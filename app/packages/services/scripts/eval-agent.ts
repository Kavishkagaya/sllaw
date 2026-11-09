// The main agent (what the chat runs) on the cases of etl/eval_agent.json: per case, whether it cites a gold section
// (any edition of that law: same_as twins count), how many of the facts the answer must state it states (regexes,
// case-insensitive), citations of chunks it never read, steps, tokens, cost; then a table per category.
//   pnpm --filter @sllaw/services eval-agent                 every case
//   pnpm --filter @sllaw/services eval-agent repealed,xref   these categories (or case ids)
// TRACE_DIR=<dir> writes each case's tool calls, results and answer to <dir>/<id>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mainAgent, SourceMap } from "@sllaw/ai";
import { linksOf } from "@sllaw/etl_db";
import { type Metered, setUsageSink } from "@sllaw/usage";
import { agentCtx } from "../src/agent";

type Case = {
  id: string;
  cat: string;
  q: string;
  lang?: string;
  gold: [string, string | null][]; // [law key, label or null: any chunk of that law]
  must: string[];
  note?: string;
};
const cases: Case[] = JSON.parse(readFileSync(new URL("../../../../etl/eval_agent.json", import.meta.url), "utf8"));
const arg = process.argv[2];
const want = arg ? new Set(arg.split(",")) : null;
const qs = cases.filter((c) => !want || want.has(c.cat) || want.has(c.id));
const traceDir = process.env.TRACE_DIR;
if (traceDir) mkdirSync(traceDir, { recursive: true });

const calls: Metered[] = [];
setUsageSink(async (es) => void calls.push(...es.filter((e) => e.kind === "llm")));
const CITE = /\[\[([a-z]\d+(?:\s*[,;]\s*[a-z]\d+)*)\]\]/g;
const SEEN = new Set(["read", "asOf"]); // tools whose output is chunks the agent has read
const tokens = (cs: Metered[], k: string) => cs.reduce((a, c) => a + (c.quantity[k] ?? 0), 0);

// a law and the documents that are the same law (other editions, the Constitution's consolidations)
const twinCache = new Map<string, Set<string>>();
async function twins(key: string) {
  let t = twinCache.get(key);
  if (!t) {
    t = new Set([key]);
    for (const dir of ["out", "in"] as const)
      for (const l of await linksOf({ docKey: key }, dir, { kinds: ["same_as"] }))
        t.add(dir === "out" ? l.dstDoc : l.srcDoc);
    twinCache.set(key, t);
  }
  return t;
}

type Row = Record<string, number | string | boolean>;
const rows: (Row & { cat: string })[] = [];
const one = async (q: Case) => {
  const ws = `eval-${q.id}`;
  const ctx = agentCtx({ workspaceId: ws, userId: "eval" });
  const t0 = Date.now();
  try {
    const map = new SourceMap();
    const r = await mainAgent(ctx, map).generate({ prompt: q.q });
    const real = (h: unknown) => (typeof h === "string" ? map.get(h, "s")?.real : undefined) as number | undefined;
    const seen = new Set<number>();
    const collect = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(collect);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const id = real(o.chunkId);
        if (id != null) seen.add(id);
        const by = real(o.byChunk);
        if (by != null && typeof o.clause === "string") seen.add(by);
        Object.values(o).forEach(collect);
      }
    };
    for (const s of r.steps) for (const t of s.toolResults) if (SEEN.has(t.toolName)) collect(t.output);
    const handles = [...r.text.matchAll(CITE)].flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
    const cited = [...new Set(handles.flatMap((h) => real(h) ?? []))];
    const got = await ctx.ports.read(cited);
    let hit: boolean | "-" = "-";
    if (q.gold.length) {
      hit = false;
      for (const [doc, label] of q.gold) {
        const t = await twins(doc);
        if (got.some((c) => t.has(c.docKey) && (label == null || c.label === label))) hit = true;
      }
    }
    const missed = q.must.filter((m) => !new RegExp(m, "i").test(r.text));
    const mine = calls.filter((c) => c.workspaceId === ws);
    const cost = mine.reduce((a, c) => a + Number(c.meta?.inferenceCost ?? NaN), 0);
    const row = {
      id: q.id,
      cat: q.cat,
      hit,
      facts: `${q.must.length - missed.length}/${q.must.length}`,
      factsOk: missed.length === 0,
      cited: cited.length,
      unread: cited.filter((id) => !seen.has(id)).length,
      steps: r.steps.length,
      input: tokens(mine, "input"),
      output: tokens(mine, "output"),
      cost: Number.isNaN(cost) ? 0 : Number(cost.toFixed(4)),
      secs: Math.round((Date.now() - t0) / 1000),
    };
    rows.push(row);
    console.log(JSON.stringify({ ...row, missed: missed.map((m) => m.slice(0, 60)) }));
    if (traceDir)
      writeFileSync(
        `${traceDir}/${q.id}.json`,
        JSON.stringify(
          {
            case: q,
            row,
            missed,
            text: r.text,
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
    console.log(JSON.stringify({ id: q.id, error: String(e).slice(0, 300) }));
  }
};
const CONCURRENCY = 5;
for (let i = 0; i < qs.length; i += CONCURRENCY) await Promise.all(qs.slice(i, i + CONCURRENCY).map(one));

const by = new Map<string, typeof rows>();
for (const r of rows) by.set(r.cat, [...(by.get(r.cat) ?? []), r]);
const line = (name: string, rs: typeof rows) => {
  const gold = rs.filter((r) => r.hit !== "-");
  const n = (k: string) => rs.reduce((a, r) => a + Number(r[k] || 0), 0);
  return [
    name.padEnd(13),
    String(rs.length).padStart(3),
    `${gold.filter((r) => r.hit === true).length}/${gold.length}`.padStart(7),
    `${rs.filter((r) => r.factsOk).length}/${rs.length}`.padStart(7),
    String(n("unread")).padStart(6),
    (n("steps") / Math.max(1, rs.length)).toFixed(1).padStart(6),
    `$${n("cost").toFixed(3)}`.padStart(8),
  ].join(" ");
};
console.log(`\n${"category".padEnd(13)}   n    hit   facts unread  steps     cost`);
for (const [cat, rs] of [...by].sort()) console.log(line(cat, rs));
console.log(line("all", rows));
const failed = rows.filter((r) => r.hit === false || !r.factsOk).map((r) => r.id);
if (failed.length) console.log(`\nnot fully right: ${failed.join(", ")}`);
