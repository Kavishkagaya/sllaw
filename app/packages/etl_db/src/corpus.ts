import { and, asc, eq, ilike, inArray } from "drizzle-orm";
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
  const where =
    direction === "out"
      ? and(eq(links.srcDoc, docKey), chunkId != null ? eq(links.srcChunk, chunkId) : undefined)
      : and(eq(links.dstDoc, docKey), chunkId != null ? eq(links.dstChunk, chunkId) : undefined);
  return db
    .select()
    .from(links)
    .where(and(where, kinds?.length ? inArray(links.kind, kinds) : undefined, ...words.map((w) => ilike(links.context, w))))
    .orderBy(asc(links.date))
    .limit(Math.min(limit, 50)); // a Code's whole-doc list runs to thousands: narrow by chunk, kinds or text
}
