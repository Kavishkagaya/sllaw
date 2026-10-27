import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./client";
import { chats, messages } from "./schema";

export type StoredMessage = { id: string; role: string; parts: unknown; usage?: unknown };

export async function chatById(id: string) {
  const [c] = await db.select().from(chats).where(eq(chats.id, id));
  return c ?? null;
}

/** Creates the chat unless the id is taken; returns the row either way, so the caller checks whose it is. */
export async function createChat(c: {
  id: string;
  workspaceId: string;
  userId: string;
  caseId: string | null;
  title: string;
}) {
  await db.insert(chats).values(c).onConflictDoNothing();
  return (await chatById(c.id))!;
}

/** A user's chats, newest first: a case's (caseId), or the plain ones outside any case (null). */
export const chatsOf = (userId: string, workspaceId: string, caseId: string | null, limit = 50) =>
  db
    .select({ id: chats.id, title: chats.title, caseId: chats.caseId, updatedAt: chats.updatedAt })
    .from(chats)
    .where(
      and(
        eq(chats.userId, userId),
        eq(chats.workspaceId, workspaceId),
        caseId ? eq(chats.caseId, caseId) : isNull(chats.caseId),
      ),
    )
    .orderBy(desc(chats.updatedAt))
    .limit(limit);

/** Puts a plain chat into a case ("Move to case"). */
export const setChatCase = (id: string, caseId: string) => db.update(chats).set({ caseId }).where(eq(chats.id, id));

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
