// The id map, the mapper around the tools, and the stream remap: in memory, fake tools.
import { tool, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChunkCache } from "./cache";
import { SourceMap } from "./map";
import { holdBack, realStream } from "./stream";
import { citesToModel, citesToReal, partsToModel, partsToReal, wrapTools } from "./wrap";

const F = "9c01d2e7-0000-4000-8000-000000000000";
const call = { toolCallId: "t", messages: [], context: {} };

describe("SourceMap", () => {
  it("mints per kind, gives the same id the same handle, fills a missing label, and reloads from json", () => {
    const m = new SourceMap();
    expect(m.handle("s", 81234)).toBe("s1");
    expect(m.handle("s", 5)).toBe("s2");
    expect(m.handle("c", `${F}:3`, "Lease, p. 1")).toBe("c1");
    expect(m.handle("s", 81234, "s. 22, Rent Act")).toBe("s1");
    expect(m.handle("s", 81234, "other")).toBe("s1");
    expect(m.get("s1")).toEqual({ kind: "s", real: 81234, label: "s. 22, Rent Act" });
    expect(m.get("s1", "c")).toBeNull();
    expect(m.get("s9")).toBeNull();
    const again = new SourceMap(JSON.parse(JSON.stringify(m.toJSON())));
    expect(again.handle("s", 81234)).toBe("s1");
    expect(again.handle("s", 99)).toBe("s3");
    expect(again.changed).toBe(true);
  });
});

// fake law and file tools in real ids, shaped as the real ones
function tools() {
  const calls: unknown[] = [];
  const t = {
    search: tool({
      description: "search",
      inputSchema: z.object({ query: z.string() }),
      execute: async () => [
        {
          chunkId: 81234,
          docKey: "act:7/1972",
          title: "RENT ACT",
          path: "Part II › section 22 — Notice.",
          label: "22",
          text: "n".repeat(500),
        },
      ],
    }),
    read: tool({
      description: "read",
      inputSchema: z.object({ chunkIds: z.array(z.number().int()).min(1).max(20) }),
      execute: async ({ chunkIds }) => {
        calls.push(chunkIds);
        return chunkIds.map((id) => ({
          chunkId: id,
          docKey: "act:7/1972",
          title: "Rent Act",
          path: null,
          label: "22",
          text: "full",
          more: id + 1,
        }));
      },
    }),
    fileRead: tool({
      description: "fileRead",
      inputSchema: z.object({ chunks: z.array(z.string()).optional(), file: z.string().optional() }),
      execute: async (i) => {
        calls.push(i);
        return { files: [{ file: F, title: "Lease", chunks: [{ chunk: `${F}:3`, page: 2, text: "from R2" }] }] };
      },
    }),
    fileSearch: tool({
      description: "fileSearch",
      inputSchema: z.object({ query: z.string(), files: z.array(z.string()).optional() }),
      execute: async () => ({ hits: [{ chunk: `${F}:3`, file: F, title: "Lease", page: 2, text: "c".repeat(400) }] }),
    }),
  };
  return { t, calls };
}

describe("wrapTools", () => {
  it("gives the model handles and snippets, caches the full text first, and maps handles back for the tool", async () => {
    const map = new SourceMap();
    const cache = new ChunkCache();
    const { t, calls } = tools();
    const w = wrapTools(t, map, cache);
    const hits = (await w.search.execute!({ query: "q" }, call)) as any[];
    expect(hits[0]).toMatchObject({ chunkId: "s1", snippet: `${"n".repeat(300)}…` });
    expect(hits[0].text).toBeUndefined();
    expect(cache.get("s", 81234)?.text).toBe("n".repeat(500));
    expect(map.get("s1")?.label).toBe("s. 22, Rent Act (Act No. 7 of 1972)");

    const read = (await w.read.execute!({ chunkIds: ["s1"] } as never, call)) as any[];
    expect(calls).toEqual([[81234]]);
    expect(read[0]).toMatchObject({ chunkId: "s1", more: "s2", text: "full" });
    await w.read.execute!({ chunkIds: ["s1"] } as never, call); // the same read again: memo, not run
    expect(calls).toHaveLength(1);

    expect(await w.read.execute!({ chunkIds: ["s7"] } as never, call)).toMatch(/No source s7 in this chat/);
    expect(await w.read.execute!({ chunkIds: [] } as never, call)).toMatch(/Bad input: chunkIds/);
  });

  it("answers fileRead of passages fileSearch returned from the cache, without the tool", async () => {
    const map = new SourceMap();
    const { t, calls } = tools();
    const w = wrapTools(t, map);
    const s = (await w.fileSearch.execute!({ query: "q" }, call)) as any;
    expect(s.hits[0]).toMatchObject({ chunk: "c1", file: "f1", page: 2, snippet: `${"c".repeat(300)}…` });
    expect(map.get("c1")).toEqual({ kind: "c", real: `${F}:3`, label: "Lease, p. 2" });
    const r = (await w.fileRead.execute!({ chunks: ["c1"] }, call)) as any;
    expect(calls).toHaveLength(0);
    expect(r).toEqual({
      files: [{ file: "f1", title: "Lease", chunks: [{ chunk: "c1", page: 2, text: "c".repeat(400) }] }],
    });
    await w.fileRead.execute!({ file: "f1" }, call); // a page read goes to the tool
    expect(calls).toEqual([{ file: F }]);
  });

  it("shows the model handle strings in the schema", () => {
    const w = wrapTools(tools().t, new SourceMap());
    const shape = (w.read.inputSchema as any).shape;
    expect(shape.chunkIds.safeParse(["s1"]).success).toBe(true);
    expect(shape.chunkIds.safeParse([1]).success).toBe(false);
  });
});

describe("citations and parts", () => {
  it("[[s1]] <-> [[81234|label]], file chunks and files too; an unknown handle is dropped", () => {
    const m = new SourceMap();
    m.handle("s", 81234, "s. 22, Rent Act");
    m.handle("c", `${F}:3`, "Lease, p. 2");
    m.handle("f", F, "Lease");
    const real = citesToReal("Notice [[s1]], lease [[c1]][[f1]], both [[s1, c1]], bad [[s9]], label [[s1|x]].", m);
    expect(real).toBe(
      `Notice [[81234|s. 22, Rent Act]], lease [[f:${F}:3|Lease, p. 2]][[file:${F}|Lease]], both [[81234|s. 22, Rent Act]][[f:${F}:3|Lease, p. 2]], bad , label [[81234|s. 22, Rent Act]].`,
    );
    expect(citesToModel(real, m)).toBe("Notice [[s1]], lease [[c1]][[f1]], both [[s1]][[c1]], bad , label [[s1]].");
    // an old chat's citation, never in a map: minted with its label
    const old = new SourceMap();
    expect(citesToModel("[[4521|s. 22, Rent Act No. 7 of 1972]]", old)).toBe("[[s1]]");
    expect(old.get("s1")?.label).toBe("s. 22, Rent Act No. 7 of 1972");
  });

  it("stored parts (real) -> the model's (handles) and back, the same each time", () => {
    const m = new SourceMap();
    const stored = [
      {
        type: "tool-read",
        state: "output-available",
        input: { chunkIds: [81234] },
        output: [{ chunkId: 81234, title: "Rent Act", label: "22", path: null, text: "t" }],
      },
      { type: "tool-fileRead", state: "output-available", input: { file: "3fa2b1c0" }, output: { files: [] } }, // an old ref: left
      { type: "text", text: "See [[81234|s. 22, Rent Act]]." },
    ];
    const model = partsToModel(stored, m);
    expect(model[0]).toMatchObject({ input: { chunkIds: ["s1"] }, output: [{ chunkId: "s1" }] });
    expect(model[1]!.input).toEqual({ file: "3fa2b1c0" });
    expect(model[2]!.text).toBe("See [[s1]].");
    expect(partsToModel(stored, m)).toEqual(model);
    expect(partsToReal(model, m)).toEqual(stored);
  });
});

describe("realStream", () => {
  it("holds back an unclosed citation", () => {
    expect(holdBack("a [[s")).toEqual(["a ", "[[s"]);
    expect(holdBack("a [[s1]] b")).toEqual(["a [[s1]] b", ""]);
    expect(holdBack("a [")).toEqual(["a ", "["]);
    expect(holdBack(`a [[${"x".repeat(300)}`)[1]).toBe("");
  });

  it("rewrites citations split over deltas and tool ids, in real form", async () => {
    const m = new SourceMap();
    m.handle("s", 81234, "s. 22, Rent Act");
    const chunks: UIMessageChunk[] = [
      { type: "tool-input-available", toolCallId: "a", toolName: "read", input: { chunkIds: ["s1"] } },
      { type: "tool-output-available", toolCallId: "a", output: [{ chunkId: "s1", more: "s1" }] },
      { type: "text-start", id: "x" },
      { type: "text-delta", id: "x", delta: "Notice [[s" },
      { type: "text-delta", id: "x", delta: "1]] applies [" },
      { type: "text-delta", id: "x", delta: "[s1" },
      { type: "text-end", id: "x" },
    ];
    const out: UIMessageChunk[] = [];
    const r = new ReadableStream<UIMessageChunk>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    }).pipeThrough(realStream(m));
    for await (const x of r as unknown as AsyncIterable<UIMessageChunk>) out.push(x);
    expect(out[0]).toMatchObject({ input: { chunkIds: [81234] } });
    expect(out[1]).toMatchObject({ output: [{ chunkId: 81234, more: 81234 }] });
    const text = out.flatMap((x) => (x.type === "text-delta" ? [x.delta] : [])).join("");
    expect(text).toBe("Notice [[81234|s. 22, Rent Act]] applies [[s1"); // the last never closed: let through as written
    expect(out.at(-1)?.type).toBe("text-end");
  });
});

describe("labels", () => {
  it("names a law with its number when its title has none", async () => {
    const { lawLabel } = await import("./specs");
    expect(
      lawLabel({ docKey: "act:7/1972", title: "Rent", path: "section 22 — Proceedings for ejectment.", label: "22" }),
    ).toBe("s. 22, Rent (Act No. 7 of 1972)");
    expect(
      lawLabel({ docKey: "cap:576", title: "MUNICIPAL COUNCILS", path: "Part XII › section 266 — X. (cont.)" }),
    ).toBe("s. 266, Municipal Councils (Cap. 576)");
    expect(lawLabel({ docKey: "act:26/2002", title: "RENT (AMENDMENT) ACT, No. 26 OF 2002", label: "8" })).toBe(
      "s. 8, Rent (Amendment) Act, No. 26 of 2002",
    );
    expect(
      lawLabel({ docKey: "constitution:21", title: "Constitution", path: "Chapter III › Article 12 — Equality." }),
    ).toBe("Art. 12, Constitution");
  });
});
