import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  sourceUrl: text("source_url").notNull(),
  kind: text("kind").notNull(),
  title: text("title"),
  docDate: text("doc_date"),
  pdfPath: text("pdf_path"),
  meta: jsonb("meta").notNull().default({}),
  qa: jsonb("qa"),
  chunksCount: integer("chunks_count").notNull().default(0),
  status: text("status").notNull(),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const chunks = pgTable("chunks", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull(),
  idx: integer("idx").notNull(),
  kind: text("kind").notNull(),
  anchor: text("anchor"),
  part: text("part"),
  chapter: text("chapter"),
  note: text("note"),
  pages: integer("pages").array(),
  breadcrumb: text("breadcrumb").notNull(),
  text: text("text").notNull(),
});

export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;

export interface QaReport {
  kind?: string;
  ok?: boolean;
  chunks?: number;
  sections?: number;
  coverage?: number;
  page_reach?: number | null;
  notes?: number;
  flags?: string[];
}
