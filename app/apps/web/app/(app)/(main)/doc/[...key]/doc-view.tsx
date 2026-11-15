"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** A law's text beside the file it was built from (our stored PDF, or the HTML page): side by side on a wide
 *  screen, tabs on a phone. */
export function DocView({
  text,
  source,
}: {
  text: React.ReactNode;
  source: { kind: "pdf" | "html"; url: string } | null;
}) {
  const [tab, setTab] = useState<"text" | "source">("text");
  // the cited chunk (#c<id>): marked and scrolled to here, not by :target, which a client navigation (pushState from
  // the chat's "Open the law") never sets; the text pane is its own scroll area, so the page's scroll misses it too
  useEffect(() => {
    const mark = () => {
      for (const el of document.querySelectorAll("[data-cited]")) el.removeAttribute("data-cited");
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      el.setAttribute("data-cited", "");
      el.scrollIntoView({ block: "start" });
    };
    mark();
    addEventListener("hashchange", mark);
    return () => removeEventListener("hashchange", mark);
  }, []);
  const name = source?.kind === "html" ? "Page" : "PDF";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex shrink-0 gap-1 border-b px-3 py-1.5 lg:hidden">
        {(["text", "source"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "h-11 rounded-md px-4 text-sm font-medium text-muted-foreground sm:h-8",
              tab === t && "bg-accent text-foreground",
            )}
          >
            {t === "text" ? "Text" : name}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <main className={cn("min-w-0 flex-1 overflow-y-auto", tab !== "text" && "hidden lg:block")}>{text}</main>
        <section
          aria-label={`The law as stored (${name})`}
          className={cn("min-w-0 flex-1 border-l bg-muted/40", tab === "source" ? "flex" : "hidden lg:flex")}
        >
          {source ? (
            <iframe
              title={`The law as stored (${name})`}
              src={source.url}
              className="h-full w-full flex-1 border-0 bg-white"
              // the stored HTML page runs no scripts and reaches nothing of ours
              sandbox={source.kind === "html" ? "" : undefined}
            />
          ) : (
            <p className="m-auto px-6 text-center text-sm text-muted-foreground">
              No stored copy of this law's PDF or page yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
