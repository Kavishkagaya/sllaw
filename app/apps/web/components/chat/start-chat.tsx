"use client";
import { useRouter } from "next/navigation";
import { Composer } from "@/components/composer";
import { useChatStore } from "@/stores/chat-store";

/** A question box that starts a chat (in a case with caseId) and opens it: the chat is created in the store and
 *  sent here, so its answer is already streaming when its page opens (the page takes the live chat from the store). */
export function StartChat({ caseId, placeholder }: { caseId?: string; placeholder?: string }) {
  const router = useRouter();
  const send = useChatStore((s) => s.send);
  return (
    <Composer
      draftKey={caseId ? `case:${caseId}` : "home"}
      placeholder={placeholder}
      onSend={(text) => {
        const id = crypto.randomUUID();
        send(id, text, caseId);
        router.push(caseId ? `/cases/${caseId}/chats/${id}` : `/chats/${id}`);
      }}
    />
  );
}
