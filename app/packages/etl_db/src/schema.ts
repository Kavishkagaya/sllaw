// The law corpus: the schema `kb` in the ETL's state database (Neon sllaw-etl), filled by the v2 pipeline's publish
// step (etl/v2/downstream.py) in one transaction per release; read-only here, no migrations. A chunk's id is its
// vid (the same id as in the Zilliz `chunks` collection, under 2**53); its text is not in the database but in R2,
// in the text part kb.docs.parts[part] names (./text.ts). Ids are stable across rebuilds (uuid5 of the chunk's
// address), but the app database still stores doc_key + label + quote, never a chunk id alone.
import { bigint, date, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const kb = pgSchema("kb");

export const docs = kb.table("docs", {
  key: text().primaryKey(), // act:9/2023 | law:5/1972 | cap:107 | constitution:21 ...
  kind: text().notNull(),
  title: text(),
  year: integer(),
  certified: date(),
  commenced: date(),
  commencement: jsonb(),
  longTitle: text("long_title"),
  sourceUrl: text("source_url"), // the official page or PDF the text was built from
  parts: text().array().notNull(), // R2 keys of the text parts, in order
  meta: jsonb(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
});

export const chunks = kb.table("chunks", {
  id: bigint({ mode: "number" }).primaryKey(),
  uuid: uuid().notNull(), // the chunk's id inside its text part
  docKey: text("doc_key").notNull(),
  address: text().notNull(),
  seq: integer().notNull(),
  label: text(), // 'section 22', 'Article 91', 'First Schedule'
  kind: text(), // unit | schedule | front | block
  path: text(), // breadcrumb: "Part II — ... › section 13 — ... (cont.)"
  part: integer().notNull(), // index into docs.parts
  textHash: text("text_hash").notNull(),
});

export const links = kb.table("links", {
  id: bigint({ mode: "number" }).primaryKey(),
  srcDoc: text("src_doc").notNull(),
  srcChunk: bigint("src_chunk", { mode: "number" }),
  kind: text().notNull(), // amends | inserts | replaces | repeals | amends_act | repeals_act | cites | made_under | rescinds | same_as | consolidates
  dstDoc: text("dst_doc").notNull(),
  dstLabel: text("dst_label"),
  dstChunk: bigint("dst_chunk", { mode: "number" }),
  status: text(), // resolved | label_not_found | target_not_held
  date: date(), // the source law's commencement
  context: text(),
  detail: jsonb(),
});
