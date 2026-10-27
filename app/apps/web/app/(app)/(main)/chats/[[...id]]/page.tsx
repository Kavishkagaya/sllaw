import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { Chat } from "@/components/chat/chat";
import { orNotFound, serverApi } from "@/trpc/server";

// Quick chats, outside any case. /chats is a new chat and /chats/<id> a stored one: one page, so a new chat becomes
// /chats/<id> on its first message (history.pushState) without leaving it. A new chat's id is minted here, a fresh one
// on every visit; the row exists from its first message (docs/APP.md, Chats). A case chat opens inside its case.
export default async function ChatsPage({ params }: { params: Promise<{ id?: string[] }> }) {
  const { id } = await params;
  if (!id) {
    const fresh = randomUUID();
    return <Chat key={fresh} id={fresh} initial={[]} fresh />;
  }
  if (id.length > 1) notFound();
  const chatId = id[0]!;
  const c = await orNotFound((await serverApi()).chat.open({ chatId }));
  if (c.chat?.caseId) redirect(`/cases/${c.chat.caseId}/chats/${chatId}`);
  // the stored messages seed the chat store only when this chat is not already live in it
  return <Chat key={chatId} id={chatId} title={c.chat?.title} initial={c.messages as never} />;
}
