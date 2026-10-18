import { aliasedTable, and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import { chunks, docs, links } from "./schema";

const docCols = { key: docs.key, kind: docs.kind, title: docs.title, year: docs.year, commenced: docs.commenced };
const chunkCols = { id: chunks.id, docKey: chunks.docKey, seq: chunks.seq, label: chunks.label, path: chunks.path, text: chunks.text };

export async function docWithChunks(key: string) {
  const [doc] = await db.select(docCols).from(docs).where(eq(docs.key, key));
  if (!doc) return null;
  const parts = await db.select(chunkCols).from(chunks).where(eq(chunks.docKey, key)).orderBy(asc(chunks.seq));
  return { ...doc, chunks: parts };
}

/** A law's title, key and source link, for the viewer. */
export async function docInfo(key: string) {
  const [d] = await db.select({ key: docs.key, title: docs.title, sourceUrl: docs.sourceUrl }).from(docs).where(eq(docs.key, key));
  return d ?? null;
}

/** Chunks by id, each with its law's title; ids no longer in the corpus are left out. */
export async function chunksById(ids: number[]) {
  if (!ids.length) return [];
  return db
    .select({ ...chunkCols, title: docs.title })
    .from(chunks)
    .innerJoin(docs, eq(docs.key, chunks.docKey))
    .where(inArray(chunks.id, ids));
}

export type Direction = "out" | "in";

/**
 * Links of a chunk, or of a whole doc when chunkId is left out. "out": what it amends or cites; "in": what amends
 * or cites it. An "in" link whose target the ETL did not resolve to a chunk (dst_chunk null) shows only on the doc.
 * `text` keeps the links whose context has every one of its words (ILIKE; one doc's links, not the whole table).
 */
export async function linksOf(
  target: { docKey: string; chunkId?: number | null },
  direction: Direction,
  opts: { kinds?: string[]; text?: string; limit?: number } = {},
) {
  const { kinds, text, limit = 50 } = opts;
  const words = (text ?? "").split(/\s+/).filter(Boolean).map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
  const { docKey, chunkId } = target;
  // a chunk id is unique across a law's alias keys (chapter:203, cap1956:203): match it alone, not with dst_doc
  const where =
    direction === "out"
      ? chunkId != null ? eq(links.srcChunk, chunkId) : eq(links.srcDoc, docKey)
      : chunkId != null ? eq(links.dstChunk, chunkId) : eq(links.dstDoc, docKey);
  return db
    .select()
    .from(links)
    .where(and(where, kinds?.length ? inArray(links.kind, kinds) : undefined, ...words.map((w) => ilike(links.context, w))))
    .orderBy(asc(links.date))
    .limit(Math.min(limit, 50)); // a Code's whole-doc list runs to thousands: narrow by chunk, kinds or text
}

export const CHANGE_KINDS = ["amends", "inserts", "replaces", "repeals"];

/** The changes made to chunks: each change link with its amending chunk (label, text) and law title, oldest first.
 *  By dst_chunk alone, so every alias key of the law is covered. */
export async function changesInto(chunkIds: number[]) {
  if (!chunkIds.length) return [];
  const src = aliasedTable(chunks, "src");
  return db
    .select({
      dstChunk: links.dstChunk, kind: links.kind, date: links.date, srcDoc: links.srcDoc, srcChunk: links.srcChunk,
      srcTitle: docs.title, srcLabel: src.label, srcText: src.text, context: links.context,
    })
    .from(links)
    .leftJoin(src, eq(src.id, links.srcChunk))
    .leftJoin(docs, eq(docs.key, links.srcDoc))
    .where(and(inArray(links.dstChunk, chunkIds), inArray(links.kind, CHANGE_KINDS)))
    .orderBy(asc(links.date));
}

/** Per chunk: how many amending sections changed it, the last change's date, and whether one repealed it. */
export async function changeStatus(chunkIds: number[]) {
  if (!chunkIds.length) return [];
  return db
    .select({
      chunkId: links.dstChunk,
      changes: sql<number>`count(distinct ${links.srcChunk})::int`,
      last: sql<string | null>`max(${links.date})::text`,
      repealed: sql<string | null>`max(${links.date}) filter (where ${links.kind} = 'repeals')::text`,
    })
    .from(links)
    .where(and(inArray(links.dstChunk, chunkIds), inArray(links.kind, CHANGE_KINDS)))
    .groupBy(links.dstChunk);
}
