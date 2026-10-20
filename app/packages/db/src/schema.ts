// The app tables (drizzle-kit migrations). Every row is keyed by our own ids (uuid); Clerk ids (user_..., org_...)
// live only in users.clerk_id and workspaces.clerk_id, filled by the Clerk webhook (services/accounts.ts).
import { index, json, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(), // Clerk's org role without the prefix: admin | member
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const cases = pgTable("cases", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
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
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }), // null: plain chat
    title: text().notNull(),
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
    chatId: uuid("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    role: text().notNull(), // user | assistant
    // json, not jsonb: jsonb reorders keys, so replayed tool-call inputs no longer matched what the model sent and the
    // provider's prompt cache missed from the first tool call on (chat of 2026-10-20: 2,432 of 18,186 tokens cached)
    parts: json().notNull(),
    usage: jsonb(), // assistant only: tokens and cost of the turn (ai's Usage)
    createdAt,
  },
  (t) => [index().on(t.chatId, t.createdAt)],
);
