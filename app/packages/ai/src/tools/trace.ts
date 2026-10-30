// trace: the link walk the agent asks for, built for what it needs now. From one chunk, a decision model (Jev, via
// ctx.ports.decide: one yes/no per link, answered as a probability) scores every link around the chunk against the
// agent's need; the walk follows the best ones a few levels deep and returns the tree it kept. The model only picks
// among links the corpus has, so the tree holds no made-up ids; links with no chunk on the other side are returned as
// leads, unscored (find them with a keyword search). Experimental: offered only when ctx.ports.decide is set.
import { tool } from "ai";
import { z } from "zod";
import type { Direction, Link, Ports } from "../ports";

export type TraceInput = {
  docKey: string;
  chunkId: number;
  need: string;
  direction?: Direction | "both";
  depth?: number;
  limit?: number;
};
export type TraceNode = {
  chunkId: number;
  from: number | null; // the chunk it was reached from; null for the start
  docKey: string;
  label: string | null;
  kind: string | null; // the link's kind, as seen from `from`: out = `from` refers to it, in = it refers to `from`
  direction: Direction | null;
  p: number | null; // the decision model's probability that following the link serves the need
  context: string | null; // the text around the reference
  linked?: { chunkId: number; docKey: string }; // where the link pointed, when that was an older edition of the law
  depth: number;
};
export type Lead = { from: number; docKey: string; label: string | null; kind: string };
export type Trace = { nodes: TraceNode[]; leads: Lead[]; scored: number; calls: number };

const MIN_P = 0.5; // below this a link is not followed
const BRANCH = 4; // links followed from one chunk at most
const PER_NODE = 60; // links scored around one chunk at most (hub sections are cited thousands of times)
const BATCH = 30; // questions per decide call
const STATE_CHARS = 1200; // of the chunk's text, in the state
const CONTEXT_CHARS = 300;

const cut = (s: string | null | undefined, n: number) => (!s ? null : s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

type Edge = { link: Link; dir: Direction; chunk: number | null; doc: string };

/** The walk itself, on ports alone (the tool and the tests call it). */
export async function trace(ports: Ports, input: TraceInput): Promise<Trace> {
  if (!ports.decide) throw new Error("trace needs ports.decide");
  const dirs: Direction[] = !input.direction || input.direction === "both" ? ["out", "in"] : [input.direction];
  const depth = input.depth ?? 2;
  const limit = input.limit ?? 12;
  const seen = new Set([input.chunkId]);
  const nodes: TraceNode[] = [
    {
      chunkId: input.chunkId,
      from: null,
      docKey: input.docKey,
      label: null,
      kind: null,
      direction: null,
      p: null,
      context: null,
      depth: 0,
    },
  ];
  const leads: Lead[] = [];
  let scored = 0;
  let calls = 0;
  let level = [nodes[0]!];

  for (let d = 1; d <= depth && level.length && nodes.length < limit; d++) {
    const texts = new Map((await ports.read(level.map((n) => n.chunkId))).map((c) => [c.chunkId, c]));
    const picked = await Promise.all(
      level.map(async (n) => {
        const edges: Edge[] = [];
        const byChunk = new Set<number>();
        for (const dir of dirs)
          for (const link of await ports.links({ docKey: n.docKey, chunkId: n.chunkId }, dir)) {
            const chunk = dir === "out" ? link.dstChunk : link.srcChunk;
            const doc = dir === "out" ? link.dstDoc : link.srcDoc;
            if (chunk == null) {
              if (
                dir === "out" &&
                leads.length < 20 &&
                !leads.some((l) => l.docKey === doc && l.label === link.dstLabel)
              )
                leads.push({ from: n.chunkId, docKey: doc, label: link.dstLabel, kind: link.kind });
              continue;
            }
            if (seen.has(chunk) || byChunk.has(chunk)) continue;
            byChunk.add(chunk);
            edges.push({ link, dir, chunk, doc });
          }
        const cand = edges.slice(0, PER_NODE);
        if (!cand.length) return [];
        const c = texts.get(n.chunkId);
        const state =
          `A lawyer's research needs: ${input.need}\n\n` +
          `The provision being read (${n.docKey}${c?.path ? `, ${c.path}` : ""}):\n${cut(c?.text, STATE_CHARS) ?? "(no text)"}`;
        const ps: Record<string, number> = {};
        for (let i = 0; i < cand.length; i += BATCH) {
          const qs: Record<string, string> = {};
          for (let j = i; j < Math.min(i + BATCH, cand.length); j++) qs[`e${j}`] = question(cand[j]!);
          Object.assign(ps, await ports.decide!(state, qs));
          calls++;
        }
        scored += cand.length;
        return cand
          .map((e, i) => ({ e, p: ps[`e${i}`] ?? 0 }))
          .filter((x) => x.p >= MIN_P)
          .sort((a, b) => b.p - a.p)
          .slice(0, BRANCH)
          .map(({ e, p }) => ({ from: n, e, p }));
      }),
    );
    // the best links of the whole level first, so the node limit cuts the weakest
    const next: TraceNode[] = [];
    const ranked = picked.flat().sort((a, b) => b.p - a.p);
    // a link into the 1978 Constitution or a 1956 chapter: follow the same part in the newest edition instead
    const newer = ports.latest ? await ports.latest([...new Set(ranked.map((x) => x.e.chunk!))]) : {};
    for (const { from, e, p } of ranked) {
      if (nodes.length >= limit) break;
      const to = newer[e.chunk!];
      const id = to?.chunkId ?? e.chunk!;
      if (seen.has(id)) continue;
      seen.add(id);
      seen.add(e.chunk!);
      const node: TraceNode = {
        chunkId: id,
        ...(to && { linked: { chunkId: e.chunk!, docKey: e.doc } }),
        from: from.chunkId,
        docKey: to?.docKey ?? e.doc,
        label: e.dir === "out" ? e.link.dstLabel : null,
        kind: e.link.kind,
        direction: e.dir,
        p: Math.round(p * 100) / 100,
        context: cut(e.link.context, CONTEXT_CHARS),
        depth: d,
      };
      nodes.push(node);
      next.push(node);
    }
    level = next;
  }
  return { nodes, leads, scored, calls };
}

function question({ link, dir, doc }: Edge) {
  const where = `${doc}${dir === "out" && link.dstLabel ? `, ${link.dstLabel}` : ""}`;
  const what =
    dir === "out"
      ? `This provision refers to ${where} (${link.kind}${link.date ? `, ${link.date}` : ""}).`
      : `${where} refers to this provision (${link.kind}${link.date ? `, ${link.date}` : ""}).`;
  return (
    `${what} The text around the reference: "${cut(link.context, CONTEXT_CHARS) ?? "(none)"}". ` +
    "Would reading that provision help answer the research need?"
  );
}

export const traceTool = (ports: Ports) =>
  tool({
    description:
      "Follow the links around a chunk for what you need now, in one call: a fast decision model scores every link " +
      "in and out of the chunk against `need` and follows the best ones up to `depth` levels. Returns the tree it " +
      "kept: each node's chunk id, the chunk it was reached from, the law, the link's kind and direction, the " +
      "probability it serves the need, and the text around the reference; and leads, links whose target was not " +
      "resolved (find them with a keyword search in that law). Read the nodes you will rely on; the tree is a map, " +
      "not evidence. Use it when a provision's answer turns on what it refers to or what refers to it (definitions, " +
      "exceptions, regulations made under it, later laws that changed or replaced it); for a section's amendments " +
      "use asOf.",
    inputSchema: z.object({
      docKey: z.string().describe("the chunk's law, as a hit or link gave it"),
      chunkId: z.number().int(),
      need: z.string().min(3).describe("what you are looking for now, in one or two English sentences"),
      direction: z.enum(["out", "in", "both"]).optional().describe("default both"),
      depth: z.number().int().min(1).max(3).optional().describe("levels to follow, default 2"),
      limit: z.number().int().min(2).max(25).optional().describe("chunks in the tree at most, default 12"),
    }),
    execute: async (input) => {
      const t0 = Date.now();
      const out = await trace(ports, input);
      // one line per call in the runtime logs, to judge the experiment from Vercel's logs
      console.log(
        `[trace] ${JSON.stringify({
          ms: Date.now() - t0,
          input,
          scored: out.scored,
          calls: out.calls,
          nodes: out.nodes.map((n) => [n.chunkId, n.from, n.docKey, n.label, n.kind, n.direction, n.p]),
          leads: out.leads.length,
        })}`,
      );
      return out;
    },
  });
