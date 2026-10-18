// The law corpus, written by etl.publish (etl/publish.py) and read-only here; no migrations. publish truncates these
// tables and a rebuild renumbers chunk ids, so the app database never stores a chunk id as a lasting reference.
import { bigint, date, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

export const docs = pgTable("docs", {
  key: text().primaryKey(), // act:9/2023 | law:5/1972 | cap:107 | constitution:21 ...
  kind: text().notNull(),
  title: text(),
  year: integer(),
  certified: date(),
  commenced: date(),
  commencement: jsonb(),
  meta: jsonb().notNull(),
});

export const chunks = pgTable("chunks", {
  id: bigint({ mode: "number" }).primaryKey(),
  docKey: text("doc_key").notNull(),
  seq: integer().notNull(),
  label: text(), // 'section 22', 'Article 91', 'First Schedule'
  path: text(), // breadcrumb: "Part II — ... › section 13 — ... (cont.)"
  text: text().notNull(),
});

export const links = pgTable("links", {
  id: bigint({ mode: "number" }).primaryKey(),
  srcDoc: text("src_doc").notNull(),
  srcChunk: bigint("src_chunk", { mode: "number" }),
  kind: text().notNull(), // amends | inserts | replaces | repeals | amends_act | repeals_act | cites | same_as | consolidates
  dstDoc: text("dst_doc").notNull(),
  dstLabel: text("dst_label"),
  dstChunk: bigint("dst_chunk", { mode: "number" }),
  date: date(),
  context: text(),
});
