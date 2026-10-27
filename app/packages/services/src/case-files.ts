// A case's files as its agent's file tools see them (ai's CaseFile): the rows' state and card, from Postgres alone, so
// a turn starts with no blob reads; a file's chunks and its summary are read from the store only when a tool asks.
// Pure over the rows and a store, so tests run it in memory; agent.ts reads the rows.
import type { CaseFile, FileChunk } from "@sllaw/ai";
import type { FileRow } from "@sllaw/db";
import { chunkPages } from "@sllaw/search";
import { type BlobStore, getJson } from "@sllaw/storage";
import { keys } from "./files/pipeline";

type Meta = Partial<
  Pick<CaseFile, "parties" | "dates" | "caseNumbers" | "lawsCited" | "tags"> & {
    title: string;
    language: string;
    court: string | null;
  }
>;

function stateOf(f: FileRow): CaseFile["state"] {
  if (f.extractState === "done") return "ready";
  if (f.extractState === "no_text" || f.extractState === "failed") return "unreadable";
  return "processing";
}

/** The case's files, oldest first. Files whose upload failed or that are being deleted are left out. */
export function caseFilesFrom(rows: FileRow[]): CaseFile[] {
  const live = rows
    .filter((f) => f.uploadState === "stored" || f.uploadState === "pending")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return live.map((f) => {
    const m = (f.meta ?? {}) as Meta;
    return {
      id: f.id,
      name: f.name,
      title: m.title ?? null,
      docType: f.category,
      language: m.language ?? null,
      pages: f.pages,
      state: f.uploadState === "stored" ? stateOf(f) : "processing",
      searchable: f.indexState === "done",
      parties: m.parties ?? [],
      dates: m.dates ?? [],
      court: m.court ?? null,
      caseNumbers: m.caseNumbers ?? [],
      lawsCited: m.lawsCited ?? [],
      tags: m.tags ?? [],
    };
  });
}

/** A file's chunks as the index cut them (chunks.json), or cut the same way from its extract when it is not indexed
 *  yet (the same chunker, so the ids match once it is). */
export async function chunksOf(store: BlobStore, fileId: string): Promise<FileChunk[] | null> {
  const indexed = await getJson<{ n: number; page: number; text: string }[]>(store, keys.chunks(fileId));
  if (indexed) return indexed.map(({ n, page, text }) => ({ n, page, text }));
  const x = await getJson<{ pages: { n: number; text: string }[] }>(store, keys.extract(fileId));
  return x ? chunkPages(fileId, x.pages).map(({ n, page, text }) => ({ n, page, text })) : null;
}

/** A case file's chunks, once per request: an agent often reads one file several times. Only the case's files: any
 *  other id is null. */
export function chunksReader(files: CaseFile[], store: () => BlobStore) {
  const ids = new Set(files.map((f) => f.id));
  const cache = new Map<string, Promise<FileChunk[] | null>>();
  return (fileId: string) => {
    if (!ids.has(fileId)) return Promise.resolve(null);
    let p = cache.get(fileId);
    if (!p) {
      p = chunksOf(store(), fileId);
      p.catch(() => cache.delete(fileId)); // a failed read is tried again on the next call
      cache.set(fileId, p);
    }
    return p;
  };
}

/** A case file's summary from its card, when asked (fileCard). Only the case's files; a missing card is null. */
export function summaryReader(files: CaseFile[], store: () => BlobStore) {
  const ids = new Set(files.map((f) => f.id));
  return async (fileId: string) =>
    ids.has(fileId) ? ((await getJson<{ summary?: string }>(store(), keys.card(fileId)))?.summary ?? null) : null;
}
