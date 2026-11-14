"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, BookOpen, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
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
import { useUploadStore } from "@/stores/upload-store";
import { useTRPC } from "@/trpc/client";

// The question box. Its text is a draft in the chat store (draftKey: the chat id, "new" on the home page), so it
// survives moving around the app. Enter sends, Shift+Enter is a new line. While an answer runs, send becomes stop.
// The book button picks a playbook for the next message (docs/APP.md, Playbooks): only those of where the lawyer is
// (case-only ones in a case), and no button when there are none. In a case, the clip adds files to the case (the upload
// tray follows them).
export function Composer({
  draftKey,
  onSend,
  onStop,
  busy,
  autoFocus,
  inCase = false,
  caseId,
  placeholder = "Ask about Sri Lankan law…",
}: {
  caseId?: string;
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
  const upload = useUploadStore((s) => s.upload);
  const files = useRef<HTMLInputElement>(null);
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim(), picked ?? undefined);
    setDraft(draftKey, "");
    setPicked(null);
  };
  const tool =
    "h-11 gap-1.5 border bg-card px-2.5 text-[12.5px] text-muted-foreground shadow-none hover:text-foreground sm:h-8";
  return (
    <form
      onSubmit={send}
      className="relative rounded-xl border border-input bg-card shadow-md transition-shadow focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/15"
    >
      {picked && (
        <div className="flex px-3 pt-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-law px-2.5 py-0.5 text-xs text-law-ink">
            <BookOpen className="size-3" />
            {picked}
            <button
              type="button"
              onClick={() => setPicked(null)}
              aria-label="Remove playbook"
              className="-mr-1 flex size-5 items-center justify-center opacity-70 hover:opacity-100"
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
        placeholder={busy ? "Neethi is working… you can keep typing" : placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="max-h-60 min-h-16 resize-none border-0 bg-transparent px-4 pt-3 pb-1 text-[15px] shadow-none focus-visible:ring-0 md:text-[15px] dark:bg-transparent"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5">
        {caseId && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`${tool} w-11 sm:w-8`}
              aria-label="Add files to this case"
              title="Add files to this case"
              onClick={() => files.current?.click()}
            >
              <Paperclip />
            </Button>
            <input
              ref={files}
              type="file"
              multiple
              hidden
              accept=".pdf,.docx,.txt,.html,image/*"
              onChange={(e) => {
                for (const f of Array.from(e.target.files ?? [])) upload(f, { kind: "case", caseId });
                e.target.value = "";
              }}
            />
          </>
        )}
        {playbooks.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className={tool}>
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
        <span className="flex-1" />
        {busy && onStop ? (
          <Button type="button" variant="outline" onClick={onStop} className="h-11 gap-2 sm:h-9">
            <span className="size-2.5 rounded-[2px] bg-foreground" aria-hidden />
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="size-11 rounded-lg sm:size-9"
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </form>
  );
}
