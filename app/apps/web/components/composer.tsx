"use client";
import { ArrowUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// The question box: Enter sends, Shift+Enter is a new line.
export function Composer({ onSend, busy, autoFocus }: { onSend: (text: string) => void; busy?: boolean; autoFocus?: boolean }) {
  const [input, setInput] = useState("");
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim());
    setInput("");
  };
  return (
    <form onSubmit={send} className="relative rounded-xl border bg-card shadow-sm transition-shadow focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/15">
      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(e)}
        placeholder="Ask about Sri Lankan law…"
        autoFocus={autoFocus}
        rows={2}
        className="max-h-60 min-h-20 resize-none border-0 bg-transparent px-4 py-3 pr-14 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send" className="absolute right-3 bottom-3 rounded-full">
        <ArrowUp />
      </Button>
    </form>
  );
}
