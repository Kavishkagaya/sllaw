// The main agent's tools on the law corpus: schema and description here (they are prompt), the work in ctx.ports.
// They work in real chunk ids and return full text; the model sees handles and snippets (sources/: the mapper cuts a
// hit to its first lines after caching it whole).
import { tool } from "ai";
import { z } from "zod";
import type { Ctx } from "../ports";

const docKey = z.string().describe("a law's key, from a hit or a link: act:9/2023, law:5/1972, cap:107, cap1956:331");
const chunkId = z.number().int();

export const lawTools = ({ ports }: Ctx) => ({
  search: tool({
    description:
      "Search the Sri Lankan statute corpus. The query must be English (translate Sinhala/Tamil first). " +
      "mode 'dense' (default) for questions in plain words; 'weighted' for plain words plus an exact string " +
      "(a section or Article number, 'No. N of YYYY', Cap. N, a defined term); 'keyword' to find given words only, " +
      "e.g. 'section 51' within docKeys, or a phrase from a link's text to find the chunk it points at. " +
      "Returns the start of each hit only: read the ones you need in full.",
    inputSchema: z.object({
      query: z.string(),
      mode: z.enum(["dense", "weighted", "keyword"]).optional(),
      docKeys: z.array(docKey).optional().describe("only these laws"),
      yearFrom: z.number().int().optional(),
      yearTo: z.number().int().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ query, mode, limit, ...filters }) => {
      const hits = await ports.search(query, { mode, filters, limit });
      // dense always returns something when the laws have text: nothing at all means they have none (law:16/1974)
      if (!hits.length && filters.docKeys?.length && !(await ports.search(query, { filters, limit: 1 })).length)
        return `${filters.docKeys.join(", ")}: no text in the corpus. Do not search it again; use its links, or say so in gaps.`;
      const st = await ports.status(hits.map((h) => h.chunkId));
      return hits.map(({ score, ...h }) => {
        const x = st[h.chunkId];
        return {
          ...h,
          // from the links, so the agent sees at a glance which hits are as enacted and which were changed
          status: !x
            ? "no recorded change"
            : x.repealed
              ? `repealed ${x.repealed}`
              : `changed by ${x.changes} amending section(s), last ${x.last ?? "undated"}`,
        };
      });
    },
  }),
  read: tool({
    description:
      "Read chunks in full, by id (from search or links). Each comes with the whole section it is in, from its first " +
      "chunk; a section that goes on further ends with 'more': the next chunk's id, to read if you need the rest.",
    inputSchema: z.object({ chunkIds: z.array(chunkId).min(1).max(20) }),
    execute: ({ chunkIds }) => ports.read(chunkIds),
  }),
  links: tool({
    description:
      "What refers to a chunk or a whole law ('in'), or what it refers to ('out'), grouped by the other law and kind: " +
      "how many links, the chunk ids on the other side (up to 10), and for 'out' the parts named (labels; a label " +
      "without a chunk id was not resolved: find it with a keyword search in that law). kinds: amends, inserts, " +
      "replaces, repeals, amends_act, repeals_act, cites, same_as, consolidates. For what changed a section, use asOf " +
      "instead. On a whole law narrow with kinds or text (words that must all be in the link's text, e.g. 'section 43').",
    inputSchema: z.object({
      docKey,
      chunkId: chunkId.optional(),
      direction: z.enum(["in", "out"]),
      kinds: z.array(z.string()).optional(),
      text: z.string().optional(),
    }),
    execute: async ({ direction, kinds, text, ...target }) => {
      const groups = new Map<
        string,
        { law: string; kind: string; links: number; chunkIds: number[]; parts: string[]; date: string | null }
      >();
      for (const l of await ports.links(target, direction, { kinds, text })) {
        const law = direction === "in" ? l.srcDoc : l.dstDoc;
        const g = groups.get(law + l.kind) ?? { law, kind: l.kind, links: 0, chunkIds: [], parts: [], date: l.date };
        g.links++;
        const ch = direction === "in" ? l.srcChunk : l.dstChunk;
        if (ch != null && !g.chunkIds.includes(ch) && g.chunkIds.length < 10) g.chunkIds.push(ch);
        if (direction === "out" && l.dstLabel && !g.parts.includes(l.dstLabel) && g.parts.length < 10)
          g.parts.push(l.dstLabel);
        groups.set(law + l.kind, g);
      }
      return [...groups.values()].map(({ parts, ...g }) => (parts.length ? { ...g, parts } : g));
    },
  }),
  asOf: tool({
    description:
      "A section as enacted and every change made to it up to the question's date, oldest first: the amending law " +
      "and section, the kind (amends, inserts, replaces, repeals) and that amending section's text, which holds the " +
      "new words. A long amending text is cut short and marked '…[truncated]': read that chunk before saying what " +
      "the rest of it changes. Changes after the date are only named. Use it before saying what a section says now; " +
      "one call on any chunk of the section covers all its amendments. The date is the chat's unless you give one: " +
      "give date to see the section as it stood earlier (when a contract was made, an act done, a case decided).",
    inputSchema: z.object({
      chunkId,
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        // a real day: Date rolls 2005-02-30 over to March, so it must come back unchanged
        .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), "not a date")
        .optional()
        .describe("YYYY-MM-DD; left out, the chat's date"),
    }),
    execute: ({ chunkId, date }) => ports.asOf(chunkId, date),
  }),
});
