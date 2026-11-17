// The main agent's tools on the law corpus: schema and description here (they are prompt), the work in ctx.ports.
// They work in real chunk ids and return full text; the model sees handles and snippets (sources/: the mapper cuts a
// hit to its first lines after caching it whole).
import { tool } from "ai";
import { z } from "zod";
import type { Ctx, Later } from "../ports";

const docKey = z
  .string()
  .describe(
    "a law's, gazette's or judgment's key, from a hit or a link: act:9/2023, law:5/1972, cap:107, cap1956:331, gazette:2345/03, ca:…, sc:…",
  );
const isJudgment = (key: string) => /^(ca|sc):/.test(key);
const isGazette = (key: string) => key.startsWith("gazette:");

/** A gazette's currency from its links: "rescinded by gazette:2123/35 (2019-05-15); amended by gazette:2049/31
 *  (2017-12-14)", the rescission first; the later gazette's key is there to search (docKeys) and cite. */
export function gazetteStatus(later: Later[] | undefined) {
  if (!later?.length) return "no later gazette amending or rescinding it recorded";
  const one = (x: Later) => `${x.by}${x.date ? ` (${x.date})` : ""}`;
  const of = (kind: Later["kind"]) => later.filter((x) => x.kind === kind).map(one);
  const r = of("rescinds");
  const a = of("amends");
  return [r.length && `rescinded by ${r.join(", ")}`, a.length && `amended by ${a.join(", ")}`]
    .filter(Boolean)
    .join("; ");
}
const chunkId = z.number().int();

export const lawTools = ({ ports }: Ctx) => ({
  search: tool({
    description:
      "Search Sri Lankan law: the laws (Acts, Laws, the Revised Editions, the Constitution, and regulations: Gazettes " +
      "Extraordinary from 2010, keys gazette:…), and the judgments of the Court of Appeal and the Supreme Court from 2021. " +
      "only: 'laws' or 'judgments' (or one court) to search just those; left out, both. yearFrom/yearTo: by the year " +
      "of the Act, the gazette or the judgment. " +
      "The query must be English (translate Sinhala/Tamil first). " +
      "mode 'dense' (default; 'weighted' when only judgments) for questions in plain words; 'weighted' for plain words plus an exact string " +
      "(a section or Article number, 'No. N of YYYY', Cap. N, a defined term); 'keyword' to find given words only, " +
      "e.g. 'section 51' within docKeys, or a phrase from a link's text to find the chunk it points at. " +
      "Returns the start of each law hit only: read the ones you need in full. A judgment or gazette hit is the whole " +
      "passage; a gazette hit's status names the later gazettes that amended or rescinded it.",
    inputSchema: z.object({
      query: z.string(),
      mode: z.enum(["dense", "weighted", "keyword"]).optional(),
      only: z.enum(["laws", "judgments", "courtOfAppeal", "supremeCourt"]).optional(),
      docKeys: z.array(docKey).optional().describe("only these laws or judgments"),
      yearFrom: z.number().int().optional(),
      yearTo: z.number().int().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ query, mode: asked, limit, ...filters }) => {
      // judgments are found by their words more than laws are: weighted put the judgment a question was written from
      // in the top 10 for 7/10, dense for 4/10 (chat-judgments d6, 2026-11-17)
      const judgments = !!filters.only && filters.only !== "laws";
      const mode = asked ?? (judgments ? "weighted" : undefined);
      // and 20 of them: for the agent's own short queries the judgment sought ranked 12th-25th (d6, 2026-11-17)
      const hits = await ports.search(query, { mode, filters, limit: limit ?? (judgments ? 20 : undefined) });
      // dense always returns something when the laws have text: nothing at all means they have none (law:16/1974)
      if (!hits.length && filters.docKeys?.length && !(await ports.search(query, { filters, limit: 1 })).length)
        return `${filters.docKeys.join(", ")}: no text in the corpus. Do not search it again; use its links, or say so in gaps.`;
      const st = await ports.status(
        hits.filter((h) => !isJudgment(h.docKey) && !isGazette(h.docKey)).map((h) => h.chunkId),
      );
      const later = await ports.later(hits.map((h) => h.docKey).filter(isGazette));
      return hits.map(({ score, ...h }) => {
        // a judgment hit comes whole (`passage`, not cut to a snippet): what the agent cites from it is what it read, and
        // the app shows it as read (chat-judgments d2: snippets were cited unread, 10 of 10 eval runs' unread citations)
        if (isJudgment(h.docKey)) {
          const { text, ...rest } = h;
          return { ...rest, kind: "judgment", passage: text };
        }
        // a gazette hit comes whole too (paragraphs run to 1,809 chars, as judgment passages): an enumerating answer
        // cited 15 gazette snippets unread (chat-regulations s1 walk)
        if (isGazette(h.docKey)) {
          const { text, ...rest } = h;
          return { ...rest, kind: "gazette", passage: text, status: gazetteStatus(later[h.docKey]) };
        }
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
    execute: async ({ chunkIds }) => {
      const rows = await ports.read(chunkIds);
      const gz = rows.map((r) => r.docKey).filter(isGazette);
      if (!gz.length) return rows;
      // a regulation read says whether a later gazette amended or rescinded it (chat-regulations d4)
      const later = await ports.later(gz);
      return rows.map((r) => (isGazette(r.docKey) ? { ...r, status: gazetteStatus(later[r.docKey]) } : r));
    },
  }),
  links: tool({
    description:
      "What refers to a chunk or a whole law ('in'), or what it refers to ('out'), grouped by the other law and kind: " +
      "how many links, the chunk ids on the other side (up to 10), and for 'out' the parts named (labels). Every link " +
      "is resolved; a provision the ETL could not find is not listed (find it with a keyword search in that law). " +
      "A law's own references ('under section 12') are 'out' links to itself and in 'in' only for a chunk. kinds: amends, inserts, " +
      "replaces, repeals, amends_act, repeals_act, rescinds, made_under, cites, same_as, consolidates. For what changed a section, use asOf " +
      "instead. At most 50 links, 'in' newest first: on a whole law narrow with chunkId, kinds or text (words that must " +
      "all be in the link's text, e.g. 'section 43').",
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
