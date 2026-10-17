// The app tables (drizzle-kit migrations). Every row is keyed by workspace_id. Ids are Clerk's (org_..., user_...).
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text().primaryKey(), // Clerk organization id
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  "members",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // Clerk user id
    role: text().notNull(), // owner | member
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const cases = pgTable("cases", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text().notNull(),
  facts: text().notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
