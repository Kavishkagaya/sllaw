import { type AsOf, type Chunk, type Ctx, runResearch } from "@sllaw/ai";
import { chunksById, linksOf } from "@sllaw/etl_db";
import { searchLaw } from "@sllaw/search";

const CHANGES = ["amends", "inserts", "replaces", "repeals", "repeals_act"];

const asChunk = (c: { id: number; docKey: string; title?: string | null; label: string | null; path: string | null; text: string }): Chunk => ({
  chunkId: c.id, docKey: c.docKey, title: c.title ?? null, label: c.label, path: c.path, text: c.text,
});

type Who = { workspaceId: string; userId: string; caseId?: string | null; asOfDate?: string };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" }); // YYYY-MM-DD

/**
 * The ctx agents run with. The caller has already checked access (api: chatOwner, and caseEditor for a case chat),
 * so the scopes here are what this request may reach. User-file ports join here (#19).
 */
export function agentCtx({ workspaceId, userId, caseId = null, asOfDate = today() }: Who): Ctx {
  return {
    workspaceId,
    userId,
    caseId,
    asOfDate,
    scopes: [`user:${userId}`, ...(caseId ? [`case:${caseId}`] : [])],
    ports: {
      search: (query, opts) => searchLaw(query, opts),
      read: async (ids) => (await chunksById(ids)).map(asChunk),
      links: (target, direction, opts) => linksOf(target, direction, opts),
      async asOf(chunkId): Promise<AsOf | null> {
        const [c] = await chunksById([chunkId]);
        if (!c) return null;
        const ls = await linksOf({ docKey: c.docKey, chunkId }, "in", { kinds: CHANGES });
        return {
          chunk: asChunk(c),
          date: asOfDate,
          inForce: ls.filter((l) => l.date && l.date <= asOfDate),
          later: ls.filter((l) => l.date && l.date > asOfDate),
          undated: ls.filter((l) => !l.date),
        };
      },
    },
  };
}

export async function research(question: string, who: Who) {
  return (await runResearch(agentCtx(who), question)).pack;
}
