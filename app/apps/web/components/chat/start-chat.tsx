"use client";
import { useRouter } from "next/navigation";
import { CasePicker } from "@/components/chat/case-picker";
import { Composer } from "@/components/composer";
import { useChatStore } from "@/stores/chat-store";

/** A question box that starts a chat (in a case with caseId) and opens it: the chat is created in the store and
 *  sent here, so its answer is already streaming when its page opens (the page takes the live chat from the store). */
export function StartChat({
  caseId,
  placeholder,
  picker,
}: {
  caseId?: string;
  placeholder?: string;
  /** the case chip (the dashboard's box): picking a case opens its new chat page with the draft */
  picker?: boolean;
}) {
  const router = useRouter();
  const send = useChatStore((s) => s.send);
  return (
    <Composer
      draftKey={caseId ? `case:${caseId}` : "home"}
      placeholder={placeholder}
      inCase={!!caseId}
      chip={picker ? <CasePicker draftKey={caseId ? `case:${caseId}` : "home"} /> : undefined}
      onSend={(text, playbook) => {
        const id = crypto.randomUUID();
        send(id, text, caseId, playbook);
        router.push(caseId ? `/cases/${caseId}/chats/${id}` : `/chats/${id}`);
      }}
    />
  );
}
