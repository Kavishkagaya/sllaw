"use client";
import { useChat } from "@ai-sdk/react";
import type { AppRouter, ChatMessage } from "@sllaw/api";
import { useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { ArrowLeft, BookMarked, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Composer } from "@/components/composer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { useTRPC } from "../../../../trpc/client";
import { splitAnswer, Trail } from "./trail";

type View = NonNullable<inferRouterOutputs<AppRouter>["corpus"]["chunk"]>;
type Cite = { id: number; label: string };

// The main agent cites inline as [[chunkId|label]]. Each becomes a link Streamdown renders through `a` below, as a
// button with the agent's label; clicking it loads that chunk into the sidebar by id.
const CITE = /\[\[(\d+)(?:\|([^\]|]*))?\]\]/g;
const toLinks = (s: string) => s.replace(CITE, (_, id, label) => `[${(label || "source").trim()}](#cite-${id})`);

const EXAMPLES = [
  "What notice must a landlord give to evict a tenant under the Rent Act?",
  "Which Article of the Constitution protects freedom of expression, and what limits it?",
  "What is the limitation period for an action on a written contract?",
];
const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;

/** A chat: empty (fresh, at /chats) it shows the welcome and the question box in the middle; its first message
 *  moves the box down, brings the thread in and makes the URL /chats/<id> in place, so nothing reloads. */
export function Chat({
  id,
  title,
  initial,
  fresh,
}: {
  id: string;
  title?: string;
  initial: ChatMessage[];
  fresh?: boolean;
}) {
  // the chat lives in the store: this page only shows it, and leaving the page does not stop an answer
  const chat = useChatStore((s) => s.open)(id, initial);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const { messages, status, error } = useChat<ChatMessage>({ chat });
  // this chat is on screen: its answer is read as it arrives, and an unread mark from before is cleared
  const onScreen = useChatStore((s) => s.view);
  useEffect(() => {
    onScreen(id);
    return () => onScreen(null);
  }, [id, onScreen]);
  // the server has more than an idle store copy (an answer stored after a reload cut its stream): take the server's
  useEffect(() => {
    if (chat.status === "ready" && initial.length > chat.messages.length) chat.messages = initial;
  }, [chat, initial]);
  const [open, setOpen] = useState<Cite | null>(null);
  const [sheet, setSheet] = useState(false);
  // below xl the panel is a sheet; at xl it is always beside the thread
  const show = useCallback((c: Cite) => {
    setOpen(c);
    setSheet(!matchMedia("(min-width: 80rem)").matches);
  }, []);
  // the open citation, fetched by chunk id (corpus.chunk); cached, so reopening one is instant
  const trpc = useTRPC();
  const view = useQuery(trpc.corpus.chunk.queryOptions({ chunkId: open?.id ?? 0 }, { enabled: !!open }));

  // ids the agent loaded (a citation of any other id is unverified) and every citation in its answers, in order
  const { loaded, cites } = useMemo(() => {
    const loaded = new Set<number>();
    const cites: Cite[] = [];
    for (const m of messages)
      for (const p of m.parts) {
        // what the agent read in full: a citation of anything else is unverified
        if (p.type === "tool-read" && p.state === "output-available") for (const c of p.output) loaded.add(c.chunkId);
        if (p.type === "tool-asOf" && p.state === "output-available" && p.output) {
          loaded.add(p.output.chunk.chunkId);
          for (const ch of p.output.changes) if (ch.byChunk != null) loaded.add(ch.byChunk); // its clause was shown
        }
        if (p.type === "text" && m.role === "assistant")
          for (const [, n, label] of p.text.matchAll(CITE))
            if (!cites.some((c) => c.id === +n!)) cites.push({ id: +n!, label: label || "source" });
      }
    return { loaded, cites };
  }, [messages]);

  // keep the newest message in view while it streams. Braces matter: newer browsers (Chrome 153, recent mobile
  // Safari) return a Promise from scrollIntoView, and an effect that returns one crashes React on cleanup
  const end = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the trigger, not an input
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  const empty = messages.length === 0;
  const ask = (text: string) => {
    send(id, text);
    // a fresh chat takes its own URL on its first message; Next syncs its router with pushState (no request)
    if (fresh && !location.pathname.endsWith(id)) history.pushState(null, "", `${location.pathname}/${id}`); // /chats → /chats/<id>
  };

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const m = href?.match(/^#cite-(\d+)$/);
        if (!m)
          return (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          );
        const n = +m[1]!;
        const ok = loaded.has(n);
        const chip = (
          <button
            type="button"
            onClick={() => show({ id: n, label: String(children) })}
            className={cn(
              "mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-px align-baseline font-sans text-xs font-medium whitespace-nowrap transition-colors",
              ok
                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                : "border-dashed border-destructive/50 text-destructive",
              open?.id === n && "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {!ok && <TriangleAlert className="size-3" />}
            {children}
          </button>
        );
        return ok ? (
          chip
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{chip}</TooltipTrigger>
            <TooltipContent>Cited but never read by the agent: unverified</TooltipContent>
          </Tooltip>
        );
      },
    }),
    [loaded, open, show],
  );

  const panel = <CitationPanel open={open} cites={cites} view={view} onPick={show} onBack={() => setOpen(null)} />;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3" style={{ borderBottomWidth: empty ? 0 : 1 }}>
          <SidebarTrigger />
          {!empty && (
            <motion.h1 initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="truncate text-sm font-medium">
              {title ??
                messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text")?.text ??
                "New chat"}
            </motion.h1>
          )}
          {!empty && (
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="ml-auto xl:hidden">
                  <BookMarked /> Citations {cites.length > 0 && <Badge variant="secondary">{cites.length}</Badge>}
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full gap-0 p-0 sm:max-w-md xl:hidden">
                <SheetTitle className="sr-only">Citations</SheetTitle>
                {panel}
              </SheetContent>
            </Sheet>
          )}
        </header>
        <div className={cn("flex min-h-0 flex-1 flex-col", empty && "justify-center pb-24")}>
          <AnimatePresence mode="popLayout" initial={false}>
            {empty ? (
              <motion.div
                key="welcome"
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2 }}
                className="mx-auto w-full max-w-2xl space-y-2 px-4 pb-8 text-center"
              >
                <h2 className="font-serif text-3xl font-semibold tracking-tight sm:text-4xl">
                  What would you like to research?
                </h2>
                <p className="text-muted-foreground">
                  Answers drawn from the Constitution and Acts of Sri Lanka, each with its citation.
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="thread"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: 0.1 }}
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
                  {messages.map((m) =>
                    m.role === "user" ? (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={SPRING}
                        className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-4 py-2.5 whitespace-pre-wrap text-secondary-foreground"
                      >
                        {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
                      </motion.div>
                    ) : (
                      <motion.div key={m.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <Answer parts={m.parts} live={busy && m.id === messages.at(-1)?.id} components={components} />
                      </motion.div>
                    ),
                  )}
                  {status === "submitted" && (
                    <Step icon={Loader2} spin>
                      Researching…
                    </Step>
                  )}
                  {error && (
                    <Alert variant="destructive">
                      <TriangleAlert />
                      <AlertDescription>Something went wrong: {error.message}</AlertDescription>
                    </Alert>
                  )}
                  <div ref={end} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {/* the same box in both states: layout animates it from the middle to the bottom */}
          <motion.div
            layout
            transition={SPRING}
            className={cn("mx-auto w-full px-4", empty ? "max-w-2xl" : "max-w-3xl pb-4")}
          >
            <Composer
              draftKey={fresh ? "new" : id}
              onSend={ask}
              onStop={() => stop(id)}
              busy={busy}
              autoFocus={empty}
            />
            <AnimatePresence initial={false}>
              {empty ? (
                <motion.div
                  key="examples"
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="grid gap-2 overflow-hidden pt-4 sm:grid-cols-3"
                >
                  {EXAMPLES.map((q) => (
                    <button
                      type="button"
                      key={q}
                      onClick={() => ask(q)}
                      className="rounded-lg border bg-card p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {q}
                    </button>
                  ))}
                </motion.div>
              ) : (
                <motion.p
                  key="note"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-2 text-center text-[11px] text-muted-foreground"
                >
                  Research aid, not legal advice. Check the cited text before relying on it.
                </motion.p>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
      {!empty && <aside className="hidden w-96 shrink-0 border-l bg-sidebar xl:block">{panel}</aside>}
    </div>
  );
}

function Answer({
  parts,
  live,
  components,
}: {
  parts: ChatMessage["parts"];
  live: boolean;
  components: Record<string, unknown>;
}) {
  const { trail, answer } = splitAnswer(parts);
  return (
    <div className="flex flex-col gap-3">
      <Trail parts={trail} live={live && !answer.some((p) => p.type === "text" && p.text)} />
      {answer.map(
        (p, i) =>
          p.type === "text" && (
            <Streamdown key={i} className="md" components={components as never} isAnimating={live}>
              {toLinks(p.text)}
            </Streamdown>
          ),
      )}
    </div>
  );
}

function Step({
  icon: Icon,
  spin,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon className={cn("size-3.5", spin && "animate-spin")} />
      <span className="truncate">{children}</span>
    </div>
  );
}

function CitationPanel({
  open,
  cites,
  view,
  onPick,
  onBack,
}: {
  open: Cite | null;
  cites: Cite[];
  view: {
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    error: { message: string } | null;
    data: View | null | undefined;
  };
  onPick: (c: Cite) => void;
  onBack: () => void;
}) {
  if (!open)
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <h2 className="text-sm font-medium">Citations</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {!cites.length ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
              <BookMarked className="size-5" />
              The provisions an answer cites appear here.
            </div>
          ) : (
            <ol className="flex flex-col gap-1">
              {cites.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c)}
                    className="flex w-full gap-3 rounded-md p-2 text-left text-sm hover:bg-sidebar-accent"
                  >
                    <span className="w-5 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums">
                      {i + 1}
                    </span>
                    <span>{c.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="All citations">
          <ArrowLeft />
        </Button>
        <h2 className="truncate text-sm font-medium">{open.label}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {view.isPending && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {view.isError && <p className="text-sm text-destructive">Could not load it: {view.error?.message}</p>}
        {view.isSuccess &&
          (view.data ? (
            <Provision v={view.data} />
          ) : (
            <p className="text-sm text-destructive">This provision is no longer in the corpus.</p>
          ))}
      </div>
    </div>
  );
}

function Provision({ v }: { v: View }) {
  const { chunk: c, doc } = v;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-serif text-lg leading-snug font-semibold">{doc?.title ?? c.docKey}</h3>
        <p className="text-xs text-muted-foreground">{c.path ?? c.label}</p>
      </div>
      <div className="border-l-2 border-brass pl-3 font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
        {c.text}
      </div>
      {v.changes.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Changed by, up to {v.date}
          </h4>
          <ul className="space-y-3">
            {v.changes.map((ch, i) => (
              <li key={i} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <a
                    href={`/doc/${ch.by}${ch.byChunk ? `#c${ch.byChunk}` : ""}`}
                    target="_blank"
                    className="font-medium hover:underline"
                    rel="noopener"
                  >
                    {ch.byTitle ?? ch.by}
                  </a>
                  {ch.byLabel && <span className="text-muted-foreground">s. {ch.byLabel}</span>}
                  <Badge variant="outline" className="ml-auto">
                    {ch.kind}
                  </Badge>
                </div>
                {ch.date && <p className="text-xs text-muted-foreground">{ch.date}</p>}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {ch.clause.slice(0, 240)}
                  {ch.clause.length > 240 ? "…" : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {v.later.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Later: {v.later.map((l) => `${l.by} ${l.kind} (${l.date})`).join("; ")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/doc/${c.docKey}#c${c.chunkId}`} target="_blank" rel="noopener">
            Open full document <ExternalLink />
          </a>
        </Button>
        {doc?.sourceUrl && (
          <Button asChild variant="ghost" size="sm">
            <a href={doc.sourceUrl} target="_blank" rel="noreferrer">
              Source file <ExternalLink />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
