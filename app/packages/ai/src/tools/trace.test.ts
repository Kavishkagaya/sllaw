// The trace walk on fake ports: a small link graph and a decide that says yes to links whose text has a word.
import { describe, expect, it } from "vitest";
import type { Link, Ports } from "../ports";
import { trace } from "./trace";

const L = (
  src: [string, number | null],
  dst: [string, number | null],
  context: string,
  kind = "cites",
  label: string | null = null,
): Link => ({
  kind,
  srcDoc: src[0],
  srcChunk: src[1],
  dstDoc: dst[0],
  dstChunk: dst[1],
  dstLabel: label,
  date: null,
  context,
});
// 1 (act:1) -> 2 "definition of tenant" -> 4 "tenant includes"; 1 -> 3 "penalty"; 5 -> 1 "regulations about tenant"
// 1 -> unresolved "section 9 of act:7"
const GRAPH: Link[] = [
  L(["act:1", 1], ["act:2", 2], "the definition of tenant in section 2", "cites", "2"),
  L(["act:1", 1], ["act:3", 3], "liable to a penalty", "cites", "3"),
  L(["act:2", 2], ["act:4", 4], "tenant includes a sub-tenant", "cites", "4"),
  L(["act:5", 5], ["act:1", 1], "regulations about tenant notices", "made_under"),
  L(["act:1", 1], ["act:7", null], "section 9 of Act No. 7", "cites", "9"),
];

function fakePorts(word: string) {
  const calls: { state: string; qs: Record<string, string> }[] = [];
  const ports = {
    read: async (ids: number[]) =>
      ids.map((chunkId) => ({ chunkId, docKey: "x", title: null, label: null, path: null, text: `chunk ${chunkId}` })),
    links: async ({ chunkId }: { chunkId?: number | null }, dir: "in" | "out") =>
      GRAPH.filter((l) => (dir === "out" ? l.srcChunk : l.dstChunk) === chunkId),
    decide: async (state: string, qs: Record<string, string>) => {
      calls.push({ state, qs });
      return Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, q.includes(word) ? 0.9 : 0.1]));
    },
  } as unknown as Ports;
  return { ports, calls };
}

describe("trace", () => {
  it("follows the links the decision model picks, both ways, to depth", async () => {
    const { ports, calls } = fakePorts("tenant");
    const t = await trace(ports, { docKey: "act:1", chunkId: 1, need: "who is a tenant" });
    expect(t.nodes.map((n) => [n.chunkId, n.from, n.direction])).toEqual([
      [1, null, null],
      [2, 1, "out"],
      [5, 1, "in"],
      [4, 2, "out"],
    ]);
    expect(t.nodes.find((n) => n.chunkId === 2)?.label).toBe("2");
    expect(t.leads).toEqual([{ from: 1, docKey: "act:7", label: "9", kind: "cites" }]);
    expect(calls[0]!.state).toContain("who is a tenant");
    expect(t.scored).toBe(4); // 2, 3, 5 around 1; 4 around 2 (1 already seen)
  });

  it("stops at depth and limit", async () => {
    const { ports } = fakePorts("tenant");
    expect((await trace(ports, { docKey: "act:1", chunkId: 1, need: "x", depth: 1 })).nodes).toHaveLength(3);
    expect((await trace(ports, { docKey: "act:1", chunkId: 1, need: "x", limit: 2 })).nodes).toHaveLength(2);
  });

  it("keeps one direction when asked, and nothing below the threshold", async () => {
    const { ports } = fakePorts("tenant");
    const out = await trace(ports, { docKey: "act:1", chunkId: 1, need: "x", direction: "out" });
    expect(out.nodes.map((n) => n.chunkId)).toEqual([1, 2, 4]);
    const none = await trace(fakePorts("nothing matches").ports, { docKey: "act:1", chunkId: 1, need: "x" });
    expect(none.nodes).toHaveLength(1);
  });

  it("moves a node into the newest edition, keeping where the link pointed", async () => {
    const { ports } = fakePorts("tenant");
    (ports as any).latest = async (ids: number[]) =>
      ids.includes(2) ? { 2: { chunkId: 20, docKey: "constitution:21" } } : {};
    const t = await trace(ports, { docKey: "act:1", chunkId: 1, need: "x", direction: "out", depth: 1 });
    expect(t.nodes[1]).toMatchObject({
      chunkId: 20,
      docKey: "constitution:21",
      linked: { chunkId: 2, docKey: "act:2" },
    });
  });
});
