import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { chats, messages } from "./schema";

export type StoredMessage = { id: string; role: string; parts: unknown; usage?: unknown };

export async function chatById(id: string) {
  const [c] = await db.select().from(chats).where(eq(chats.id, id));
  return c ?? null;
}

/** Creates the chat unless the id is taken; returns the row either way, so the caller checks whose it is. */
export async function createChat(c: { id: string; workspaceId: string; userId: string; title: string }) {
  await db.insert(chats).values(c).onConflictDoNothing();
  return (await chatById(c.id))!;
}

export const chatsOf = (userId: string, workspaceId: string, limit = 50) =>
  db
    .select({ id: chats.id, title: chats.title, caseId: chats.caseId, updatedAt: chats.updatedAt })
    .from(chats)
    .where(and(eq(chats.userId, userId), eq(chats.workspaceId, workspaceId)))
    .orderBy(desc(chats.updatedAt))
    .limit(limit);

export const messagesOf = (chatId: string): Promise<StoredMessage[]> =>
  db
    .select({ id: messages.id, role: messages.role, parts: messages.parts })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));

/** Upserts by message id (a continued assistant message replaces its parts and usage) and touches the chat. */
export async function saveMessages(chatId: string, ms: StoredMessage[]) {
  if (!ms.length) return;
  await db
    .insert(messages)
    .values(ms.map((m) => ({ ...m, chatId })))
    .onConflictDoUpdate({ target: messages.id, set: { parts: sql`excluded.parts`, usage: sql`excluded.usage` } });
  await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));
}
