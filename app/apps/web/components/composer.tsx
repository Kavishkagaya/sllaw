"use client";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useChatStore } from "@/stores/chat-store";

// The question box. Its text is a draft in the chat store (draftKey: the chat id, "new" on the home page), so it
// survives moving around the app. Enter sends, Shift+Enter is a new line. While an answer runs, send becomes stop.
export function Composer({
  draftKey,
  onSend,
  onStop,
  busy,
  autoFocus,
  placeholder = "Ask about Sri Lankan law…",
}: {
  placeholder?: string;
  draftKey: string;
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  const input = useChatStore((s) => s.drafts[draftKey] ?? "");
  const setDraft = useChatStore((s) => s.setDraft);
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim());
    setDraft(draftKey, "");
  };
  return (
    <form
      onSubmit={send}
      className="relative rounded-xl border bg-card shadow-md transition-shadow focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/15"
    >
      <Textarea
        value={input}
        onChange={(e) => setDraft(draftKey, e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(e)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="max-h-60 min-h-20 resize-none border-0 bg-transparent px-4 py-3 pr-14 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
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
