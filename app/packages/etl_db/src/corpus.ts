import { aliasedTable, and, asc, eq, ilike, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "./client";
import { chunks, docs, links } from "./schema";
import { partTexts, sourceFileUrl } from "./text";

const docCols = { key: docs.key, kind: docs.kind, title: docs.title, year: docs.year, commenced: docs.commenced };
// uuid and part find a chunk's text in R2 (withText); callers get `text` in their place
const chunkCols = {
  id: chunks.id,
  docKey: chunks.docKey,
  seq: chunks.seq,
  label: chunks.label,
  path: chunks.path,
  uuid: chunks.uuid,
  part: chunks.part,
};

type Ref = { docKey: string; uuid: string; part: number };

/** uuid -> text for the chunks asked: their docs' part keys from kb.docs, the parts from R2 (cached). */
async function textsOf(refs: Ref[]) {
  const out = new Map<string, string>();
  if (!refs.length) return out;
  const keys = [...new Set(refs.map((r) => r.docKey))];
  const ds = await db.select({ key: docs.key, parts: docs.parts }).from(docs).where(inArray(docs.key, keys));
  const partsOf = new Map(ds.map((d) => [d.key, d.parts]));
  const byPart = new Map<string, Ref[]>();
  for (const r of refs) {
    const k = partsOf.get(r.docKey)?.[r.part];
    if (k) byPart.set(k, [...(byPart.get(k) ?? []), r]);
  }
  await Promise.all(
    [...byPart].map(async ([k, rs]) => {
      const t = await partTexts(k);
      for (const r of rs) out.set(r.uuid, t.get(r.uuid) ?? "");
    }),
  );
  return out;
}

/** Rows with their text in place of uuid and part. */
async function withText<T extends Ref>(rows: T[]) {
  const t = await textsOf(rows);
  return rows.map(({ uuid, part, ...r }) => ({ ...r, text: t.get(uuid) ?? "" }));
}

export async function docWithChunks(key: string) {
  const [doc] = await db.select(docCols).from(docs).where(eq(docs.key, key));
  if (!doc) return null;
  const parts = await db.select(chunkCols).from(chunks).where(eq(chunks.docKey, key)).orderBy(asc(chunks.seq));
  return { ...doc, chunks: await withText(parts) };
}

/** The law's stored source file, signed for the viewer: a PDF, or the HTML page it was built from. null when none. */
export async function docSource(key: string) {
  const [d] = await db.select({ sourceKey: docs.sourceKey }).from(docs).where(eq(docs.key, key));
  if (!d?.sourceKey) return null;
  return {
    kind: d.sourceKey.endsWith(".pdf") ? ("pdf" as const) : ("html" as const),
    url: await sourceFileUrl(d.sourceKey),
  };
}

/** Every law that changed this one (any part of it, or the whole law), with its earliest date, oldest first: the
 *  law's timeline. One small row per amending law; the join stays in the database. */
export async function lawChanges(key: string) {
  return db
    .select({ by: links.srcDoc, title: docs.title, date: sql<string | null>`min(${links.date})` })
    .from(links)
    .leftJoin(docs, eq(docs.key, links.srcDoc))
    .where(and(eq(links.dstDoc, key), inArray(links.kind, [...CHANGE_KINDS, "amends_act", "repeals_act"])))
    .groupBy(links.srcDoc, docs.title)
    .orderBy(sql`min(${links.date})`);
}

/** A law's title, key and source link, for the viewer. */
export async function docInfo(key: string) {
  const [d] = await db
    .select({ key: docs.key, title: docs.title, sourceUrl: docs.sourceUrl })
    .from(docs)
    .where(eq(docs.key, key));
  return d ?? null;
}

/** Chunks by id, each with its law's title; ids no longer in the corpus are left out. */
export async function chunksById(ids: number[]) {
  if (!ids.length) return [];
  return withText(
    await db
      .select({ ...chunkCols, title: docs.title })
      .from(chunks)
      .innerJoin(docs, eq(docs.key, chunks.docKey))
      .where(inArray(chunks.id, ids)),
  );
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
  const words = (text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
  const { docKey, chunkId } = target;
  // a chunk id is unique across a law's alias keys (chapter:203, cap1956:203): match it alone, not with dst_doc
  const where =
    direction === "out"
      ? chunkId != null
        ? eq(links.srcChunk, chunkId)
        : eq(links.srcDoc, docKey)
      : chunkId != null
        ? eq(links.dstChunk, chunkId)
        : // what refers to a law from outside it: its own "under section 12" links (docs/LINKS.md) stay out
          and(eq(links.dstDoc, docKey), ne(links.srcDoc, docKey));
  return db
    .select()
    .from(links)
    .where(
      and(where, kinds?.length ? inArray(links.kind, kinds) : undefined, ...words.map((w) => ilike(links.context, w))),
    )
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
        .where(
          and(
            eq(chunks.docKey, h.docKey),
            sql`${chunks.seq} between ${h.seq + 1} and ${h.seq + SECTION_MAX - 1}`,
            eq(chunks.path, `${h.path} (cont.)`),
          ),
        )
        .orderBy(asc(chunks.seq));
      const sec: Read[] = [h];
      for (const c of await withText(run))
        if (c.seq === sec.at(-1)!.seq + 1) sec.push(c);
        else break;
      if (sec.length === SECTION_MAX) {
        const [next] = await db
          .select({ id: chunks.id })
          .from(chunks)
          .where(
            and(eq(chunks.docKey, h.docKey), eq(chunks.seq, h.seq + SECTION_MAX), eq(chunks.path, `${h.path} (cont.)`)),
          );
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
    return (own && !sec.some((c) => c.id === id) ? [...sec, own] : sec).filter(
      (c) => !seen.has(c.id) && seen.add(c.id),
    );
  });
}

/** Each chunk with the chunk its section starts in (itself unless it is a "(cont.)" chunk). Change links point at
 *  the section's first chunk (the ETL resolves "section 22" to it), so the rest of the section shares its changes. */
async function withHeads(chunkIds: number[]) {
  const rows = await db
    .select({
      id: chunks.id,
      head: sql<number | null>`(select h.id from kb.chunks h where h.doc_key = "chunks".doc_key and h.seq < "chunks".seq
        and h.path = left("chunks".path, -8) order by h.seq desc limit 1)`.mapWith(Number),
    })
    .from(chunks)
    .where(and(inArray(chunks.id, chunkIds), like(chunks.path, "% (cont.)")));
  const head = new Map(chunkIds.map((id) => [id, id]));
  for (const r of rows) if (r.head) head.set(r.id, r.head);
  return head;
}

/** Which laws changed a section, and when (one row per amending law, earliest date): the source panel's marks on the
 *  timeline. No texts: the clauses are the history page's (changesInto). */
export async function changedBy(chunkId: number) {
  // a "(cont.)" chunk's changes are its section's: its head chunk, found inside the same statement (one round trip)
  const head = sql`(select h.id from kb.chunks h join kb.chunks c on c.id = ${chunkId} where c.path like '% (cont.)'
    and h.doc_key = c.doc_key and h.seq < c.seq and h.path = left(c.path, -8) order by h.seq desc limit 1)`;
  return db
    .select({ by: links.srcDoc, date: sql<string | null>`min(${links.date})` })
    .from(links)
    .where(and(or(eq(links.dstChunk, chunkId), eq(links.dstChunk, head)), inArray(links.kind, CHANGE_KINDS)))
    .groupBy(links.srcDoc)
    .orderBy(sql`min(${links.date})`);
}

/** Where an amending section lands: the first section of another law it changes, with that law's title (one
 *  statement); null for an ordinary section. */
export async function amendsOf(docKey: string, chunkId: number) {
  const [t] = await db
    .select({
      docKey: links.dstDoc,
      title: docs.title,
      label: links.dstLabel,
      chunkId: links.dstChunk,
      kind: links.kind,
    })
    .from(links)
    .leftJoin(docs, eq(docs.key, links.dstDoc))
    .where(and(eq(links.srcChunk, chunkId), ne(links.dstDoc, docKey), inArray(links.kind, CHANGE_KINDS)))
    .orderBy(asc(links.id))
    .limit(1);
  return t ?? null;
}

/** The changes made to chunks' sections: each change link with its amending chunk (label, text) and law title,
 *  oldest first; dstChunk is the chunk asked for. By dst_chunk alone, so every alias key of the law is covered. */
export async function changesInto(chunkIds: number[]) {
  if (!chunkIds.length) return [];
  const head = await withHeads(chunkIds);
  const src = aliasedTable(chunks, "src");
  const rows = await db
    .select({
      dstChunk: links.dstChunk,
      kind: links.kind,
      date: links.date,
      srcDoc: links.srcDoc,
      srcChunk: links.srcChunk,
      srcTitle: docs.title,
      srcLabel: src.label,
      srcUuid: src.uuid,
      srcPart: src.part,
      context: links.context,
    })
    .from(links)
    .leftJoin(src, eq(src.id, links.srcChunk))
    .leftJoin(docs, eq(docs.key, links.srcDoc))
    .where(
      and(inArray(links.dstChunk, [...new Set([...chunkIds, ...head.values()])]), inArray(links.kind, CHANGE_KINDS)),
    )
    .orderBy(asc(links.date));
  const texts = await textsOf(
    rows.flatMap((r) => (r.srcUuid != null ? [{ docKey: r.srcDoc, uuid: r.srcUuid, part: r.srcPart! }] : [])),
  );
  const withSrc = rows.map(({ srcUuid, srcPart, ...r }) => ({
    ...r,
    srcText: srcUuid != null ? (texts.get(srcUuid) ?? "") : null,
  }));
  return chunkIds.flatMap((id) =>
    withSrc.filter((r) => r.dstChunk === id || r.dstChunk === head.get(id)).map((r) => ({ ...r, dstChunk: id })),
  );
}

/** Per chunk: how many amending sections changed its section, the last change's date, and whether one repealed it. */
export async function changeStatus(chunkIds: number[]) {
  const by = new Map<number, Awaited<ReturnType<typeof changesInto>>>();
  for (const r of await changesInto(chunkIds)) by.set(r.dstChunk!, [...(by.get(r.dstChunk!) ?? []), r]);
  return [...by].map(([chunkId, rs]) => {
    const dates = rs
      .map((r) => r.date)
      .filter((d): d is string => !!d)
      .sort();
    const rep = rs
      .filter((r) => r.kind === "repeals" && r.date)
      .map((r) => r.date!)
      .sort();
    return {
      chunkId,
      changes: new Set(rs.map((r) => r.srcChunk)).size,
      last: dates.at(-1) ?? null,
      repealed: rep.at(-1) ?? null,
    };
  });
}

/** What the public Coverage page counts, in one query that returns one row: Acts and Laws, Revised Edition chapters
 *  (1956 and 1980), the amendments followed (change links into a section), and the last publish. */
export async function coverageCounts() {
  const { rows } = await db.execute<{ acts: number; chapters: number; amendments: number; updated: string | null }>(sql`
    select
      (select count(*)::int from ${docs} where ${docs.key} like 'act:%' or ${docs.key} like 'law:%') as acts,
      (select count(*)::int from ${docs} where ${docs.key} like 'cap:%' or ${docs.key} like 'cap1956:%') as chapters,
      (select count(*)::int from ${links} where ${inArray(links.kind, CHANGE_KINDS)}) as amendments,
      (select max(${docs.publishedAt})::text from ${docs}) as updated`);
  return rows[0]!;
}
