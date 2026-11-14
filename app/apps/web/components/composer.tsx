"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, BookOpen, Square, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useChatStore } from "@/stores/chat-store";
import { useTRPC } from "@/trpc/client";

// The question box. Its text is a draft in the chat store (draftKey: the chat id, "new" on the home page), so it
// survives moving around the app. Enter sends, Shift+Enter is a new line. While an answer runs, send becomes stop.
// The book button picks a playbook for the next message (docs/APP.md, Playbooks): only those of where the lawyer is
// (case-only ones in a case), and no button when there are none.
export function Composer({
  draftKey,
  onSend,
  onStop,
  busy,
  autoFocus,
  inCase = false,
  placeholder = "Ask about Sri Lankan law…",
}: {
  placeholder?: string;
  draftKey: string;
  onSend: (text: string, playbook?: string) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  inCase?: boolean;
}) {
  const input = useChatStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useChatStore((s) => s.setDraft);
  const trpc = useTRPC();
  const playbooks = useQuery(trpc.chat.playbooks.queryOptions({ inCase }, { staleTime: Infinity })).data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim(), picked ?? undefined);
    setDraft(draftKey, "");
    setPicked(null);
  };
  return (
    <form
      onSubmit={send}
      className="relative rounded-xl border bg-card shadow-md transition-shadow focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/15"
    >
      {picked && (
        <div className="flex px-3 pt-2.5">
          <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-xs">
            playbook:{picked}
            <button
              type="button"
              onClick={() => setPicked(null)}
              aria-label="Remove playbook"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        </div>
      )}
      <Textarea
        value={input}
        onChange={(e) => setDraft(draftKey, e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(e)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className={`max-h-60 min-h-20 resize-none border-0 bg-transparent px-4 py-3 pr-14 shadow-none focus-visible:ring-0 dark:bg-transparent ${playbooks.length ? "pb-12" : ""}`}
      />
      {playbooks.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute bottom-3 left-3 h-8 gap-1.5 text-muted-foreground"
            >
              <BookOpen />
              Playbooks
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Use a playbook for this message
            </DropdownMenuLabel>
            {playbooks.map((p) => (
              <DropdownMenuItem
                key={p.name}
                onSelect={() => setPicked(p.name)}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground first-letter:uppercase">{p.when}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {busy && onStop ? (
        <Button
          type="button"
          size="icon"
          onClick={onStop}
          aria-label="Stop"
          className="absolute right-3 bottom-3 rounded-full"
        >
          <Square className="fill-current" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="absolute right-3 bottom-3 rounded-full"
        >
          <ArrowUp />
        </Button>
      )}
    </form>
  );
}
