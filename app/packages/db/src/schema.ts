// The app tables (drizzle-kit migrations). Every row is keyed by our own ids (uuid); Clerk ids (user_..., org_...)
// live only in users.clerk_id and workspaces.clerk_id, filled by the Clerk webhook (services/accounts.ts).
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
