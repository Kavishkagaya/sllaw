import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { Chat } from "./chat";
import { serverApi } from "../../../../trpc/server";

export default async function ChatPage({ params, searchParams }: { params: Promise<{ chatId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { chatId } = await params;
  const { q } = await searchParams;
  const api = await serverApi();
  const c = await api.chat.open({ chatId }).catch((e) => {
    if (e instanceof TRPCError && (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")) notFound();
    throw e;
  });
  // ?q= only starts a chat with no messages yet; on a reload of an existing chat it is ignored
  return <Chat id={chatId} title={c.chat?.title ?? "New chat"} initial={c.messages as never} first={c.messages.length ? undefined : q} />;
}
