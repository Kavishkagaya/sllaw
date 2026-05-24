import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

export const acts = pgTable("acts", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  actNumber: text("act_number").notNull(),
  certifiedDate: text("certified_date"),
  description: text("description"),
  pdfUrl: text("pdf_url").notNull(),
  title: text("title"),
  certified: text("certified"),
  totalPages: integer("total_pages"),
  partsCount: integer("parts_count"),
  sectionsCount: integer("sections_count"),
  rawJson: jsonb("raw_json"),
  doclingJson: jsonb("docling_json"),
  docJson: jsonb("doc_json"),
  status: text("status").notNull(),
  error: text("error"),
  flagged: boolean("flagged").notNull().default(false),
  flagReasons: text("flag_reasons").array().notNull().default([]),
});

export const parts = pgTable("parts", {
  id: serial("id").primaryKey(),
  actId: integer("act_id").notNull(),
  partNumber: text("part_number").notNull(),
  title: text("title"),
  sectionNumbers: integer("section_numbers").array(),
  partType: text("part_type").notNull().default("part"),
});

export const sections = pgTable("sections", {
  id: serial("id").primaryKey(),
  actId: integer("act_id").notNull(),
  sectionNumber: integer("section_number").notNull(),
  shortTitle: text("short_title"),
  partNumber: text("part_number"),
  body: jsonb("body").notNull().default([]),
});

export const consolidatedStatutes = pgTable("consolidated_statutes", {
  id: serial("id").primaryKey(),
  collection: text("collection").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceType: text("source_type").notNull().default("html"),
  htmlCode: text("html_code"),
  indexTitle: text("index_title").notNull(),
  isRepealed: boolean("is_repealed").notNull().default(false),
  title: text("title"),
  description: text("description"),
  enactedDate: text("enacted_date"),
  partsCount: integer("parts_count"),
  sectionsCount: integer("sections_count"),
  rawJson: jsonb("raw_json"),
  doclingJson: jsonb("docling_json"),
  docJson: jsonb("doc_json"),
  status: text("status").notNull(),
  error: text("error"),
});

export const consolidatedParts = pgTable("consolidated_parts", {
  id: serial("id").primaryKey(),
  statuteId: integer("statute_id").notNull(),
  partNumber: text("part_number").notNull(),
  title: text("title"),
  sectionNumbers: text("section_numbers").array(),
  partType: text("part_type").notNull().default("part"),
});

export const consolidatedSections = pgTable("consolidated_sections", {
  id: serial("id").primaryKey(),
  statuteId: integer("statute_id").notNull(),
  sectionNumber: text("section_number").notNull(),
  shortTitle: text("short_title"),
  partNumber: text("part_number"),
  body: text("body").notNull().default(""),
});
