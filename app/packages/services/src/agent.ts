import { type AsOf, type CaseFile, type Change, type Chunk, type Ctx, decide, type Status } from "@sllaw/ai";
import { filesOfCase } from "@sllaw/db";
import { changeStatus, changesInto, chunksById, latestEditions, linksOf, sectionsOf } from "@sllaw/etl_db";
import { type FileIndex, fileIndex, searchLaw } from "@sllaw/search";
import { type BlobStore, blobStore } from "@sllaw/storage";
import { caseFilesFrom, chunksReader, summaryReader } from "./case-files";

const asChunk = (c: {
  id: number;
  docKey: string;
  title?: string | null;
  label: string | null;
  path: string | null;
  text: string;
}): Chunk => ({
  chunkId: c.id,
  docKey: c.docKey,
  title: c.title ?? null,
  label: c.label,
  path: c.path,
  text: c.text,
});

type Who = {
  workspaceId: string;
  userId: string;
  caseId?: string | null;
  caseBrief?: { title: string; facts: string } | null;
  caseFiles?: CaseFile[];
  asOfDate?: string;
};

/** A case's files for its agent's file tools: the rows only (Postgres), no blob reads. */
export const caseFilesOf = async (caseId: string) => caseFilesFrom(await filesOfCase(caseId));

const CLAUSE = 900; // chars of an amending section kept: the operative words come first
// no id in the text: the model sees ids only as handles, in the fields the mapper knows (byChunk)
const clip = (t: string, chunk: number | null) =>
  t.length <= CLAUSE
    ? t
    : t.slice(0, CLAUSE) + (chunk != null ? " …[truncated: read its byChunk for the full clause]" : " …[truncated]");
const RANK: Record<string, number> = { replaces: 0, repeals: 1, inserts: 2, amends: 3 };

/** A section as enacted and the changes made to it up to a date (YYYY-MM-DD), oldest first, each with its amending
 *  section's text; one row per amending section (its strongest kind). null when the id is gone. */
export async function asOf(chunkId: number, date = today()): Promise<AsOf | null> {
  const [c] = await chunksById([chunkId]);
  if (!c) return null;
  const best = new Map<string, Awaited<ReturnType<typeof changesInto>>[number]>();
  for (const r of await changesInto([chunkId])) {
    const k = r.srcChunk != null ? String(r.srcChunk) : `${r.srcDoc}|${r.context}`;
    const b = best.get(k);
    if (!b || (RANK[r.kind] ?? 9) < (RANK[b.kind] ?? 9)) best.set(k, r);
  }
  const rows = [...best.values()].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const changes: Change[] = rows
    .filter((r) => !r.date || r.date <= date)
    .map((r) => ({
      date: r.date,
      kind: r.kind,
      by: r.srcDoc,
      byTitle: r.srcTitle,
      byLabel: r.srcLabel,
      byChunk: r.srcChunk,
      clause: clip(r.srcText ?? r.context ?? "", r.srcChunk),
    }));
  const later = rows.filter((r) => r.date && r.date > date).map((r) => ({ date: r.date!, kind: r.kind, by: r.srcDoc }));
  return { chunk: asChunk(c), date, changes, later };
}

export async function status(chunkIds: number[]): Promise<Record<number, Status>> {
  return Object.fromEntries((await changeStatus(chunkIds)).map(({ chunkId, ...s }) => [chunkId!, s]));
}

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" }); // YYYY-MM-DD

/**
 * The ctx agents run with. The caller has already checked access (api: chatOwner, and caseEditor for a case chat),
 * so the scopes here are what this request may reach. File search reaches the case's scope only, and reads only
 * the files in caseFiles (caseFilesOf). `files` swaps the store and index (tests).
 */
// once per instance, so the logs show whether the trace experiment is on in this deployment
let traceLogged = false;
export function agentCtx(
  { workspaceId, userId, caseId = null, caseBrief = null, caseFiles = [], asOfDate = today() }: Who,
  files: { store?: BlobStore; index?: FileIndex } = {},
): Ctx {
  const scopes = [`user:${userId}`, ...(caseId ? [`case:${caseId}`] : [])];
  if (!traceLogged) {
    traceLogged = true;
    console.log(`[trace] experiment ${process.env.TRACE === "1" ? "on" : "off"}`);
  }
  return {
    workspaceId,
    userId,
    caseId,
    caseBrief,
    caseFiles,
    asOfDate,
    scopes,
    ports: {
      fileSearch: async (query, { fileIds, mode, limit }) =>
        caseId
          ? (files.index ?? fileIndex()).search(query, {
              workspaceId,
              scopes: [`case:${caseId}`],
              fileIds: fileIds ?? caseFiles.map((f) => f.id),
              mode,
              limit,
            })
          : [],
      fileChunks: chunksReader(caseFiles, () => files.store ?? blobStore()),
      fileSummary: summaryReader(caseFiles, () => files.store ?? blobStore()),
      search: (query, opts) => searchLaw(query, opts),
      read: async (ids) => (await sectionsOf(ids)).map((c) => ({ ...asChunk(c), ...(c.more && { more: c.more }) })),
      links: (target, direction, opts) => linksOf(target, direction, opts),
      asOf: (chunkId, date) => asOf(chunkId, date ?? asOfDate),
      status,
      latest: latestEditions,
      // the trace experiment (Jev steering the link walk): off unless TRACE=1
      ...(process.env.TRACE === "1" && {
        decide: (state, qs) => {
          console.log(`[trace] decide ${Object.keys(qs).length} questions`);
          return decide(workspaceId, state, qs);
        },
      }),
    },
  };
}
