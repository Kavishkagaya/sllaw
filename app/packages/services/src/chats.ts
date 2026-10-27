import { streamChat } from "@sllaw/ai";
import { chatById, chatsOf, createChat, messagesOf, saveMessages, setChatCase } from "@sllaw/db";
import type { Account } from "./accounts";
import { agentCtx } from "./agent";
import { caseOf } from "./cases";

type Signed = Account & { workspace: NonNullable<Account["workspace"]> };
export type UserMessage = { id: string; role: "user"; parts: { type: "text"; text: string }[] };

/** The user's chats in a case (caseId), or their plain chats outside any case (null). null when the case is not
 *  theirs to see. */
export async function listChats(a: Signed, caseId: string | null = null, limit?: number) {
  if (caseId && !(await caseOf(a, caseId))) return null;
  return chatsOf(a.user.id, a.workspace.id, caseId, limit);
}

/** The chat row if it is this user's, in this workspace, and (a case chat) in a case they can still see. */
async function ownChat(a: Signed, chatId: string) {
  const chat = await chatById(chatId);
  if (!chat || chat.userId !== a.user.id || chat.workspaceId !== a.workspace.id) return null;
  if (chat.caseId && !(await caseOf(a, chat.caseId))) return null;
  return chat;
}

/** A chat and its messages; chat null for an id not used yet (a new chat). null when the chat is someone else's,
 *  in another workspace or in a case the user cannot see: it reads as missing (docs/APP.md, Chats). */
export async function openChat(a: Signed, chatId: string) {
  const chat = await chatById(chatId);
  if (!chat) return { chat: null, messages: [] };
  if (!(await ownChat(a, chatId))) return null;
  return { chat, messages: await messagesOf(chatId) };
}

/** "Move to case": a plain chat of this user goes into one of their cases. null when either is not theirs, or the
 *  chat is already in a case. */
export async function moveChat(a: Signed, chatId: string, caseId: string) {
  const chat = await ownChat(a, chatId);
  if (!chat || chat.caseId || !(await caseOf(a, caseId))) return null;
  await setChatCase(chatId, caseId);
  return { id: chatId, caseId };
}

/** One turn: the user message is stored first, then the main agent streams its answer, stored when it ends.
 *  caseId makes a new chat a case chat (checked: the user must be able to see the case); a stored chat keeps the
 *  case it has. A case chat's agent gets the case's title and facts. abortSignal is the request's: the stop button
 *  (useChat's stop) aborts the request and with it the agent, and so does a closed tab; either way the answer so far
 *  is stored. waitUntil matters only then: on a normal end the SDK holds the response open until onFinish resolves,
 *  but a stopped request has no response left to keep the function alive for the write (on Vercel). History comes
 *  from the database, never from the client. null when the chat or the case is not this user's. */
export async function sendMessage(
  a: Signed,
  chatId: string,
  caseId: string | null,
  message: UserMessage,
  waitUntil: (p: Promise<unknown>) => void,
  abortSignal: AbortSignal,
) {
  const stored = await chatById(chatId);
  const effective = stored ? stored.caseId : caseId;
  const theCase = effective ? await caseOf(a, effective) : null;
  if (effective && !theCase) return null;
  const title = message.parts
    .map((p) => p.text)
    .join(" ")
    .slice(0, 80);
  const chat =
    stored ?? (await createChat({ id: chatId, workspaceId: a.workspace.id, userId: a.user.id, caseId, title }));
  if (chat.userId !== a.user.id || chat.workspaceId !== a.workspace.id || chat.caseId !== effective) return null;
  const history = await messagesOf(chatId);
  await saveMessages(chatId, [message]);
  const ctx = agentCtx({
    workspaceId: a.workspace.id,
    userId: a.user.id,
    caseId: effective,
    caseBrief: theCase && { title: theCase.title, facts: theCase.facts },
  });
  return streamChat(
    ctx,
    [...history, message],
    (m, usage) => waitUntil(saveMessages(chatId, [{ ...m, usage }])),
    abortSignal,
  );
}
