"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Briefcase, ChevronDown, Loader2, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chat-store";
import { useTRPC } from "@/trpc/client";

const chip =
  "h-11 max-w-56 gap-1.5 border bg-card px-2.5 text-[12.5px] text-muted-foreground shadow-none hover:text-foreground sm:h-8";

/** The case chip in a question box (new-chat-first). On a new chat it picks where the chat goes: a case opens that
 *  case's new chat page, "No case" the plain one, the typed draft carried along. On a started chat with no case it
 *  puts the chat into a case (chat.move, was "Move to case"); a case chat's chip only names its case. */
export function CasePicker({
  caseId,
  caseTitle,
  draftKey,
  chatId,
  disabled,
}: {
  caseId?: string;
  caseTitle?: string;
  /** a new chat: the draft to carry to the picked page */
  draftKey?: string;
  /** a started chat */
  chatId?: string;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const cases = useQuery(trpc.case.list.queryOptions(undefined, { enabled: open }));
  const drafts = useChatStore((s) => s.drafts);
  const setDraft = useChatStore((s) => s.setDraft);
  const move = useMutation(
    trpc.chat.move.mutationOptions({
      onSuccess: ({ caseId: to }) => {
        router.push(`/cases/${to}/chats/${chatId}`);
        router.refresh();
      },
    }),
  );
  const label = caseId ? (caseTitle ?? "This case") : "No case";

  if (chatId && caseId) {
    return (
      <span className={`inline-flex items-center rounded-md ${chip} hover:text-muted-foreground`} title={label}>
        <Briefcase className="size-3.5 shrink-0" /> <span className="truncate">{label}</span>
      </span>
    );
  }

  const go = (to?: string) => {
    if (chatId) {
      if (to) move.mutate({ chatId, caseId: to });
      return;
    }
    if (to === caseId) return;
    const text = draftKey ? (drafts[draftKey] ?? "") : "";
    const key = to ? `new:${to}` : "new";
    if (text) {
      setDraft(key, text);
      if (draftKey && draftKey !== key) setDraft(draftKey, "");
    }
    router.push(to ? `/cases/${to}/chats` : "/chats");
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={chip} disabled={disabled || move.isPending}>
          {move.isPending ? <Loader2 className="animate-spin" /> : <Briefcase />}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {chatId ? "Put this chat into a case" : "Ask in a case"}
        </DropdownMenuLabel>
        {!chatId && (
          <DropdownMenuItem onSelect={() => go()}>
            <MessageSquare /> <span>No case</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {cases.isPending && <DropdownMenuItem disabled>Loading cases…</DropdownMenuItem>}
        {cases.isError && <DropdownMenuItem disabled>Could not load your cases</DropdownMenuItem>}
        {cases.data?.length === 0 && <DropdownMenuItem disabled>No cases yet</DropdownMenuItem>}
        <div className="max-h-72 overflow-y-auto">
          {cases.data?.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => go(c.id)}>
              <Briefcase /> <span className="truncate">{c.title}</span>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/cases/new">
            <Plus /> New case
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
