import { streamChat } from "@sllaw/ai";
import { chatById, chatsOf, createChat, messagesOf, saveMessages } from "@sllaw/db";
import type { Account } from "./accounts";
import { agentCtx } from "./agent";

type Signed = Account & { workspace: NonNullable<Account["workspace"]> };
export type UserMessage = { id: string; role: "user"; parts: { type: "text"; text: string }[] };

export const listChats = (a: Signed) => chatsOf(a.user.id, a.workspace.id);

/** A chat and its messages; chat null for an id not used yet (a new chat). null when the chat is someone else's
 *  or in another workspace: it reads as missing (docs/APP.md, Chats). */
export async function openChat(a: Signed, chatId: string) {
  const chat = await chatById(chatId);
  if (chat && (chat.userId !== a.user.id || chat.workspaceId !== a.workspace.id)) return null;
  return { chat, messages: chat ? await messagesOf(chatId) : [] };
}

/** One turn: the user message is stored first, then the main agent streams its answer, stored when it ends.
 *  abortSignal is the request's: the stop button (useChat's stop) aborts the request and with it the agent, and so
 *  does a closed tab; either way the answer so far is stored. waitUntil matters only then: on a normal end the SDK
 *  holds the response open until onFinish resolves, but a stopped request has no response left to keep the function
 *  alive for the write (on Vercel). History comes from the database, never from the client. null when the chat is
 *  not this user's. */
export async function sendMessage(
  a: Signed,
  chatId: string,
  message: UserMessage,
  waitUntil: (p: Promise<unknown>) => void,
  abortSignal: AbortSignal,
) {
  const title = message.parts.map((p) => p.text).join(" ").slice(0, 80);
  const chat = await createChat({ id: chatId, workspaceId: a.workspace.id, userId: a.user.id, title });
  if (chat.userId !== a.user.id || chat.workspaceId !== a.workspace.id) return null;
  const history = await messagesOf(chatId);
  await saveMessages(chatId, [message]);
  const ctx = agentCtx({ workspaceId: a.workspace.id, userId: a.user.id });
  return streamChat(ctx, [...history, message], (m) => waitUntil(saveMessages(chatId, [m])), abortSignal);
}
