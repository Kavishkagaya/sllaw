import type { AsOf, CaseFile, Change, Chunk, Ctx, Status } from "@sllaw/ai";
import { fileById, filesOfCase } from "@sllaw/db";
import { changeStatus, changesInto, chunksById, linksOf, sectionsOf } from "@sllaw/etl_db";
import { emptyOffice, type Office } from "@sllaw/office";
import { type FileIndex, fileIndex, searchLaw } from "@sllaw/search";
import { type BlobStore, blobStore } from "@sllaw/storage";
import { caseFilesFrom, chunksReader, summaryReader } from "./case-files";
import { type CardPatch, editCard } from "./files/card";
import { OfficeError, readOffice, writeOffice } from "./office";

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
  caseOffice?: Office | null;
  chatId?: string | null; // the chat a turn runs in: the agent's office changes are recorded with it
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
export function agentCtx(
  {
    workspaceId,
    userId,
    caseId = null,
    caseBrief = null,
    caseFiles = [],
    caseOffice = null,
    chatId = null,
    asOfDate = today(),
  }: Who,
  files: { store?: BlobStore; index?: FileIndex } = {},
): Ctx {
  const scopes = [`user:${userId}`, ...(caseId ? [`case:${caseId}`] : [])];
  return {
    workspaceId,
    userId,
    caseId,
    caseBrief,
    caseFiles,
    caseOffice,
    today: today(),
    asOfDate,
    scopes,
    ports: {
      officeRead: async () => (caseId ? (await readOffice(caseId)).office : emptyOffice()),
      officeChange: async (ops, summary) => {
        if (!caseId || !caseOffice) return { ok: false, error: "Not a case chat." };
        try {
          const r = await writeOffice(caseId, ops, { by: "ai", userId, chatId, summary });
          return { ok: true, summary: r.summary, office: r.office };
        } catch (e) {
          if (e instanceof OfficeError) return { ok: false, error: e.message };
          throw e;
        }
      },
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
      fileEdit: async (fileId, patch) => {
        const f = caseFiles.some((c) => c.id === fileId) ? await fileById(fileId) : null;
        const c = f ? await editCard(f, patch as CardPatch, userId) : null;
        return c ? { title: c.title, docType: c.docType } : null;
      },
      search: (query, opts) => searchLaw(query, opts),
      read: async (ids) => (await sectionsOf(ids)).map((c) => ({ ...asChunk(c), ...(c.more && { more: c.more }) })),
      links: (target, direction, opts) => linksOf(target, direction, opts),
      asOf: (chunkId, date) => asOf(chunkId, date ?? asOfDate),
      status,
    },
  };
}
