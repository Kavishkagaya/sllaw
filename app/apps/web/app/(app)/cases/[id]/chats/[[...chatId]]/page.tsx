import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { Chat } from "@/components/chat/chat";
import { orNotFound, serverApi } from "@/trpc/server";

// A case's chats: /cases/<id>/chats is a new one, /cases/<id>/chats/<chatId> a stored one (as /chats, but the agent
// reads every question with the case's facts). A chat of another case, or a quick chat, opens where it belongs.
export default async function CaseChatPage({ params }: { params: Promise<{ id: string; chatId?: string[] }> }) {
  const { id, chatId: rest } = await params;
  const api = await serverApi();
  const theCase = await orNotFound(api.case.open({ caseId: id }));
  if (!rest) {
    const fresh = randomUUID();
    return <Chat key={fresh} id={fresh} initial={[]} fresh caseId={id} caseTitle={theCase.title} />;
  }
  if (rest.length > 1) notFound();
  const chatId = rest[0]!;
  const c = await orNotFound(api.chat.open({ chatId }));
  if (c.chat && c.chat.caseId !== id)
    redirect(c.chat.caseId ? `/cases/${c.chat.caseId}/chats/${chatId}` : `/chats/${chatId}`);
  return (
    <Chat
      key={chatId}
      id={chatId}
      title={c.chat?.title}
      initial={c.messages as never}
      caseId={id}
      caseTitle={theCase.title}
    />
  );
}
