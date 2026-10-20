import { aliasedTable, and, asc, eq, ilike, inArray, like, sql } from "drizzle-orm";
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

const SECTION_MAX = 8; // chunks of one section returned by sectionsOf; ponytail: a longer one is cut, `more` says so

/** The whole sections the chunks are in, in the order asked: each section's first chunk and its "(cont.)" chunks, up
 *  to SECTION_MAX; when a section goes on, its last chunk returned carries `more`, the next chunk's id. */
type Read = Awaited<ReturnType<typeof chunksById>>[number] & { more?: number };
export async function sectionsOf(chunkIds: number[]): Promise<Read[]> {
  if (!chunkIds.length) return [];
  const head = await withHeads(chunkIds);
  const heads = await chunksById([...new Set(head.values())]);
  const parts = await Promise.all(
    heads.map(async (h) => {
      const run = await db
        .select({ ...chunkCols, title: docs.title })
        .from(chunks)
        .innerJoin(docs, eq(docs.key, chunks.docKey))
        .where(and(eq(chunks.docKey, h.docKey), sql`${chunks.seq} between ${h.seq + 1} and ${h.seq + SECTION_MAX - 1}`,
          eq(chunks.path, `${h.path} (cont.)`)))
        .orderBy(asc(chunks.seq));
      const sec: Read[] = [h];
      for (const c of run) if (c.seq === sec.at(-1)!.seq + 1) sec.push(c); else break;
      if (sec.length === SECTION_MAX) {
        const [next] = await db.select({ id: chunks.id }).from(chunks)
          .where(and(eq(chunks.docKey, h.docKey), eq(chunks.seq, h.seq + SECTION_MAX), eq(chunks.path, `${h.path} (cont.)`)));
        if (next) sec[sec.length - 1] = { ...sec.at(-1)!, more: next.id };
      }
      return [h.id, h.path ? sec : [h]] as [number, Read[]];
    }),
  );
  const byHead = new Map(parts);
  const asked = new Map((await chunksById(chunkIds)).map((c) => [c.id, c]));
  const seen = new Set<number>();
  return chunkIds.flatMap((id) => {
    const sec = byHead.get(head.get(id)!) ?? [];
    const own = asked.get(id); // a chunk past the cut still comes back itself
    return (own && !sec.some((c) => c.id === id) ? [...sec, own] : sec).filter((c) => !seen.has(c.id) && seen.add(c.id));
  });
}

/** Each chunk with the chunk its section starts in (itself unless it is a "(cont.)" chunk). Change links point at
 *  the section's first chunk (the ETL resolves "section 22" to it), so the rest of the section shares its changes. */
async function withHeads(chunkIds: number[]) {
  const rows = await db
    .select({
      id: chunks.id,
      head: sql<number | null>`(select h.id from chunks h where h.doc_key = "chunks".doc_key and h.seq < "chunks".seq
        and h.path = left("chunks".path, -8) order by h.seq desc limit 1)`.mapWith(Number),
    })
    .from(chunks)
    .where(and(inArray(chunks.id, chunkIds), like(chunks.path, "% (cont.)")));
  const head = new Map(chunkIds.map((id) => [id, id]));
  for (const r of rows) if (r.head) head.set(r.id, r.head);
  return head;
}

/** The changes made to chunks' sections: each change link with its amending chunk (label, text) and law title,
 *  oldest first; dstChunk is the chunk asked for. By dst_chunk alone, so every alias key of the law is covered. */
export async function changesInto(chunkIds: number[]) {
  if (!chunkIds.length) return [];
  const head = await withHeads(chunkIds);
  const src = aliasedTable(chunks, "src");
  const rows = await db
    .select({
      dstChunk: links.dstChunk, kind: links.kind, date: links.date, srcDoc: links.srcDoc, srcChunk: links.srcChunk,
      srcTitle: docs.title, srcLabel: src.label, srcText: src.text, context: links.context,
    })
    .from(links)
    .leftJoin(src, eq(src.id, links.srcChunk))
    .leftJoin(docs, eq(docs.key, links.srcDoc))
    .where(and(inArray(links.dstChunk, [...new Set([...chunkIds, ...head.values()])]), inArray(links.kind, CHANGE_KINDS)))
    .orderBy(asc(links.date));
  return chunkIds.flatMap((id) => rows.filter((r) => r.dstChunk === id || r.dstChunk === head.get(id)).map((r) => ({ ...r, dstChunk: id })));
}

/** Per chunk: how many amending sections changed its section, the last change's date, and whether one repealed it. */
export async function changeStatus(chunkIds: number[]) {
  const by = new Map<number, Awaited<ReturnType<typeof changesInto>>>();
  for (const r of await changesInto(chunkIds)) by.set(r.dstChunk!, [...(by.get(r.dstChunk!) ?? []), r]);
  return [...by].map(([chunkId, rs]) => {
    const dates = rs.map((r) => r.date).filter((d): d is string => !!d).sort();
    const rep = rs.filter((r) => r.kind === "repeals" && r.date).map((r) => r.date!).sort();
    return { chunkId, changes: new Set(rs.map((r) => r.srcChunk)).size, last: dates.at(-1) ?? null, repealed: rep.at(-1) ?? null };
  });
}
