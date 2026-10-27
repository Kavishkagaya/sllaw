// The app tables (drizzle-kit migrations). Every row is keyed by our own ids (uuid); Clerk ids (user_..., org_...)
// live only in users.clerk_id and workspaces.clerk_id, filled by the Clerk webhook (services/accounts.ts).
import { sql } from "drizzle-orm";
import { bigint, index, integer, json, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text(),
  name: text(),
  imageUrl: text("image_url"),
  createdAt,
});

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(), // Clerk organization id
  name: text().notNull(),
  slug: text(),
  createdAt,
});

export const workspaceUsers = pgTable(
  "workspace_users",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(), // Clerk's org role without the prefix: admin | member
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const cases = pgTable("cases", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text().notNull(),
  facts: text().notNull().default(""),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), // null once the user is deleted
  createdAt,
});

// A chat is its creator's (docs/APP.md, Chats): the client mints the id, the first message creates the row.
export const chats = pgTable(
  "chats",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }), // null: plain chat
    title: text().notNull(),
    // the model's source handles: { s3: [81234, "s. 22, Rent Act"], c7: ["<fileId>:12", "Lease, p. 4"] } (ai's
    // SourceMap). Messages keep real ids; only the model sees handles, rebuilt from this each turn. No text.
    sources: json().$type<Record<string, [number | string, string | null]>>(),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.workspaceId, t.updatedAt)],
);

// One row per UI message (AI SDK UIMessage): parts as they streamed, tool calls and outputs included.
export const messages = pgTable(
  "messages",
  {
    id: text().primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text().notNull(), // user | assistant
    // json, not jsonb: jsonb reorders keys, so replayed tool-call inputs no longer matched what the model sent and the
    // provider's prompt cache missed from the first tool call on (chat of 2026-10-20: 2,432 of 18,186 tokens cached)
    parts: json().notNull(),
    usage: jsonb(), // assistant only: tokens and cost of the turn (ai's Usage)
    createdAt,
  },
  (t) => [index().on(t.chatId, t.createdAt)],
);

/** Why a step did not end done, and whether trying it again can help (a timeout can; a corrupt file cannot). */
export type StepError = { message: string; retryable: boolean };

// Files (docs/APP.md, Files): one row per uploaded file, the base of every use of one (a case's files, later a
// message's attachments, a logo). The row holds what the file is and how far it is processed; no content: the file,
// its text, its summary and its chunks are in the blob store under files/<id>/, and the chunks' vectors in the index.
// Each step has a state, null when the file does not need that step (a logo is done once stored):
//   pending -> running -> done | failed | no_text (extract: a scan needing OCR, or a format nothing reads)
// and `<step>_by`, what produced its output (name@version), so files done by an older version can be found and redone.
export const files = pgTable(
  "files",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text().notNull(),
    mime: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    sha256: text(), // set by the extract step (it reads the bytes); null for a file no step reads
    uploadState: text("upload_state").notNull().default("pending"), // pending | stored | failed | deleting (files.ts, markDeleting)
    extractState: text("extract_state"),
    extractBy: text("extract_by"),
    extractError: jsonb("extract_error").$type<StepError>(),
    categorizeState: text("categorize_state"),
    categorizeBy: text("categorize_by"),
    categorizeError: jsonb("categorize_error").$type<StepError>(),
    indexState: text("index_state"),
    indexBy: text("index_by"),
    indexError: jsonb("index_error").$type<StepError>(),
    pages: integer(), // from extract
    chunks: integer(), // from index
    // from categorize: the card without its summary (content, in the blob store): title, language, parties, dates,
    // court, caseNumbers, lawsCited, tags
    category: text(), // the card's docType
    meta: jsonb(),
    // who may find the file in search, set by the service that added it (case:<id>, user:<id>); the index step
    // copies them onto the vectors
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    runId: text("run_id"), // the workflow run processing it now (or last); its stream carries the live step states
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), // any state change; a step left
    // running long past this was cut off (function timeout) and may be claimed again
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// A case's files: the file is shared with everyone who can see the case (scope case:<id> in the index).
export const caseFiles = pgTable(
  "case_files",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.caseId, t.fileId] }), index().on(t.fileId)],
);
