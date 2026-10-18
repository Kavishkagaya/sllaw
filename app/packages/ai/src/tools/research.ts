// The research agent's tools: schema and description here (they are prompt), the work in ctx.ports.
import { tool } from "ai";
import { z } from "zod";
import type { Ctx } from "../ports";

const docKey = z.string().describe("a law's key, from a hit or a link: act:9/2023, law:5/1972, cap:107, cap1956:331");
const chunkId = z.number().int();
const SNIPPET = 300; // chars of each hit the model sees; it reads the ones it wants in full (keeps context small)

/** `seen` collects the id of every chunk `read` returned, so submit can check the pack against what the agent actually read. */
export const researchTools = ({ ports }: Ctx, seen = new Set<number>()) => ({
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
      return hits.map(({ text, score, ...h }) => ({
        ...h,
        snippet: text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text,
      }));
    },
  }),
  read: tool({
    description: "Read chunks in full, by id (from search or links).",
    inputSchema: z.object({ chunkIds: z.array(chunkId).min(1).max(20) }),
    execute: async ({ chunkIds }) => {
      const chunks = await ports.read(chunkIds);
      for (const c of chunks) seen.add(c.chunkId);
      return chunks;
    },
  }),
  links: tool({
    description:
      "Links of a chunk (or a whole law when chunkId is left out). direction 'in': what amends, repeals or cites it; " +
      "'out': what it amends or cites. kinds: amends, inserts, replaces, repeals, amends_act, repeals_act, cites, same_as, consolidates. " +
      "Each link has its text (context) and the target as written (dstDoc, dstLabel); dstChunk when it was resolved. " +
      "When dstChunk is missing, find the target with a keyword search in dstDoc and check it before you use it. " +
      "At most 50 come back: on a whole law, narrow with kinds or text (words that must all be in the link's text, " +
      "e.g. 'section 43', 'licence').",
    inputSchema: z.object({
      docKey,
      chunkId: chunkId.optional(),
      direction: z.enum(["in", "out"]),
      kinds: z.array(z.string()).optional(),
      text: z.string().optional(),
    }),
    execute: ({ direction, kinds, text, ...target }) => ports.links(target, direction, { kinds, text }),
  }),
  asOf: tool({
    description:
      "A chunk as enacted and the changes to it: those in force on the question's date and those after it. " +
      "Use it before saying what a section says.",
    inputSchema: z.object({ chunkId }),
    execute: async ({ chunkId }) => {
      const a = await ports.asOf(chunkId);
      if (a) seen.add(chunkId);
      return a;
    },
  }),
});
