import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Chat } from "./chat";
import { serverApi } from "../../../trpc/server";

export default async function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  const api = await serverApi();
  const c = await api.chat.open({ chatId }).catch((e) => {
    if (e instanceof TRPCError && (e.code === "NOT_FOUND" || e.code === "BAD_REQUEST")) notFound();
    throw e;
  });
  return (
    <>
      <header className="bar">
        <Link href="/">← Chats</Link>
        <strong>{c.chat?.title ?? "New chat"}</strong>
      </header>
      <Chat id={chatId} initial={c.messages as never} />
    </>
  );
}
