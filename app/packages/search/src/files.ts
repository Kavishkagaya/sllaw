// The index of users' files (docs/APP.md, User files): one row per chunk with its workspace and its scopes
// (case:<id>, user:<id>). No doc_type: categorize runs beside index, not before it, so a filter by type is resolved
// to file ids in Postgres (files.category) and passed as fileIds. Access is filtered inside the vector query, so top-k is never lost to filtering
// afterwards; services decides which scopes a request may see. A new vector DB is a new FileIndex; a new embedding
// model a new Embedder (its `by` changes, so the files indexed by the old one can be found by index_by and redone).
import { chunkPages, CHUNKER, type FileChunk } from "./chunk";
import { embed } from "./embed";
import { zilliz } from "./zilliz";

export type Attrs = { workspaceId: string; scopes: string[] };
export type FileQuery = {
  workspaceId: string;
  scopes: string[]; // what this request may see: a hit has at least one of them
  fileIds?: string[]; // only these files (a doc_type filter, resolved in Postgres)
  mode?: "dense" | "weighted";
  limit?: number;
};
export type FileHit = { id: string; fileId: string; n: number; page: number; text: string; score: number };

export interface Embedder {
  readonly by: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface FileIndex {
  readonly by: string;
  /** Replaces every chunk of a file. Stops between and inside calls when `signal` aborts (the step's time is up). */
  upsert(chunks: FileChunk[], attrs: Attrs, signal?: AbortSignal): Promise<void>;
  remove(fileId: string, signal?: AbortSignal): Promise<void>;
  search(query: string, q: FileQuery): Promise<FileHit[]>;
}

/** What the index step records on the file row (index_by): chunker + embedder + index. */
export const indexBy = (index: FileIndex) => `${CHUNKER}+${index.by}`;
export { chunkPages, CHUNKER, type FileChunk };

const BATCH = 100; // Workers AI: 100 texts and 60,000 tokens per request (etl/embed.py)
const CHARS = 150_000;

export const bgeM3: Embedder = {
  by: "bge-m3",
  async embed(texts, signal) {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; ) {
      let j = i, n = 0;
      while (j < texts.length && j - i < BATCH && (j === i || n + texts[j]!.length <= CHARS)) n += texts[j++]!.length;
      signal?.throwIfAborted();
      out.push(...(await embed(texts.slice(i, j), signal)));
      i = j;
    }
    return out;
  },
};

const ID = /^[a-z0-9:_-]{1,64}$/i; // uuids, scopes (case:<uuid>), doc types
const list = (xs: string[]) => {
  if (!xs.every((x) => ID.test(x))) throw new Error(`bad filter value: ${xs}`);
  return JSON.stringify(xs);
};

export function fileFilter(q: Pick<FileQuery, "workspaceId" | "scopes" | "fileIds">) {
  if (!q.scopes.length || (q.fileIds && !q.fileIds.length)) return null; // sees nothing
  const parts = [`workspace_id == ${list([q.workspaceId]).slice(1, -1)}`, `array_contains_any(scopes, ${list(q.scopes)})`];
  if (q.fileIds?.length) parts.push(`file_id in ${list(q.fileIds)}`);
  return parts.join(" and ");
}

export const FILES = "files"; // the collection; created by scripts/files-collection.ts

export function zillizFileIndex(embedder: Embedder = bgeM3, collectionName = FILES): FileIndex {
  return {
    by: `${embedder.by}+zilliz:${collectionName}`,
    async upsert(chunks, a, signal) {
      const fileId = chunks[0]?.fileId;
      if (!fileId) return;
      const vecs = await embedder.embed(chunks.map((c) => c.text), signal);
      await this.remove(fileId, signal);
      for (let i = 0; i < chunks.length; i += BATCH) {
        signal?.throwIfAborted();
        await zilliz("entities/insert", {
          collectionName,
          data: chunks.slice(i, i + BATCH).map((c, k) => ({
            id: c.id, vec: vecs[i + k], text: c.text, file_id: c.fileId, n: c.n, page: c.page,
            workspace_id: a.workspaceId, scopes: a.scopes,
          })),
        }, signal);
      }
    },
    async remove(fileId, signal) {
      await zilliz("entities/delete", { collectionName, filter: `file_id == ${list([fileId]).slice(1, -1)}` }, signal);
    },
    async search(query, q) {
      const filter = fileFilter(q);
      if (!filter) return [];
      const limit = q.limit ?? 10;
      const outputFields = ["file_id", "n", "page", "text"];
      const vec = await embedder.embed([query]);
      const rows: any[] =
        q.mode === "weighted"
          ? await zilliz("entities/hybrid_search", {
              collectionName, limit, outputFields,
              search: [
                { data: vec, annsField: "vec", limit: 30, filter },
                { data: [query], annsField: "sparse", limit: 30, filter },
              ],
              rerank: { strategy: "weighted", params: { weights: [0.7, 0.3] } },
            })
          : await zilliz("entities/search", { collectionName, limit, outputFields, data: vec, annsField: "vec", filter });
      return rows.map((r) => ({ id: r.id, fileId: r.file_id, n: r.n, page: r.page, text: r.text, score: r.distance }));
    },
  };
}

/** In-process index for tests: no vectors, a hit is a chunk sharing words with the query. Filters as Zilliz does. */
export function memoryFileIndex(): FileIndex & { rows(): (FileChunk & Attrs)[] } {
  let rows: (FileChunk & Attrs)[] = [];
  return {
    by: "memory",
    rows: () => rows,
    async upsert(chunks, a) {
      const ids = new Set(chunks.map((c) => c.fileId));
      rows = rows.filter((r) => !ids.has(r.fileId)).concat(chunks.map((c) => ({ ...c, ...a })));
    },
    async remove(fileId) {
      rows = rows.filter((r) => r.fileId !== fileId);
    },
    async search(query, q) {
      const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return rows
        .filter((r) => r.workspaceId === q.workspaceId && r.scopes.some((s) => q.scopes.includes(s)))
        .filter((r) => !q.fileIds || q.fileIds.includes(r.fileId))
        .map((r) => ({ r, score: r.text.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit ?? 10)
        .map(({ r, score }) => ({ id: r.id, fileId: r.fileId, n: r.n, page: r.page, text: r.text, score }));
    },
  };
}

let current: FileIndex | null = null;
/** The app's file index, picked by FILE_INDEX (zilliz | memory; default zilliz), made on first use. */
export const fileIndex = () => (current ??= process.env.FILE_INDEX === "memory" ? memoryFileIndex() : zillizFileIndex());
