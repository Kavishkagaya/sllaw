"use client";
import { useChat } from "@ai-sdk/react";
import type { ChatMessage } from "@sllaw/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookMarked,
  Briefcase,
  ChevronRight,
  FolderInput,
  Loader2,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Composer } from "@/components/composer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { useTRPC } from "@/trpc/client";
import { FileSource, LawSource } from "./source-view";
import { splitAnswer, Trail } from "./trail";

/** A citation as the client gets it (real ids; the server maps the model's handles): a law chunk, a case file's
 *  chunk, a whole case file, or an old chat's file page ([[ref:pN|label]], before chunk citations). key is the same
 *  for every citation of one source, which keeps one number in the chat. */
type Cite =
  | { kind: "law"; key: string; label: string; chunkId: number }
  | { kind: "file"; key: string; label: string; fileId: string; n: number | null }
  | { kind: "page"; key: string; label: string };

// [[81234|label]], [[f:<fileId>:<n>|label]], [[file:<fileId>|label]], old [[3fa2b1c0:p4|label]]. Each becomes a link
// Streamdown renders through `a` below, as a numbered chip; clicking it opens the source in the sidebar.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CITE = new RegExp(
  `\\[\\[(?:(\\d+)|f:(${UUID}):(\\d+)|file:(${UUID})|([0-9a-f]{8,}):p(\\d+))(?:\\|([^\\]|]*))?\\]\\]`,
  "g",
);
const citeOf = (m: RegExpMatchArray): Cite => {
  const [, law, cFile, cN, file, ref, page, label] = m;
  const l = label?.trim();
  if (law) return { kind: "law", key: `s:${law}`, label: l || "source", chunkId: +law };
  if (cFile) return { kind: "file", key: `c:${cFile}:${cN}`, label: l || "case file", fileId: cFile, n: +cN! };
  if (file) return { kind: "file", key: `f:${file}`, label: l || "case file", fileId: file, n: null };
  return { kind: "page", key: `p:${ref}:${page}|${l}`, label: l || `p. ${page}` };
};
const toLinks = (s: string) =>
  s.replace(CITE, (...m) => {
    const c = citeOf(m as unknown as RegExpMatchArray);
    return `[${c.label}](#cite:${encodeURIComponent(JSON.stringify(c))})`;
  });

const EXAMPLES = [
  "What notice must a landlord give to evict a tenant under the Rent Act?",
  "Which Article of the Constitution protects freedom of expression, and what limits it?",
  "What is the limitation period for an action on a written contract?",
];
// in a case the agent has its facts: start from them
const CASE_EXAMPLES = [
  "What are the legal issues in these facts?",
  "Which provisions apply to this case, as amended today?",
  "What facts are missing that the law turns on?",
];
const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;

/** A chat: empty (fresh, at /chats or /cases/<id>/chats) it shows the welcome and the question box in the middle;
 *  its first message moves the box down, brings the thread in and makes the URL .../chats/<id> in place, so nothing
 *  reloads. With a case (caseId, caseTitle) it is a case chat: the agent reads every question with the case's facts. */
export function Chat({
  id,
  title,
  initial,
  fresh,
  caseId,
  caseTitle,
}: {
  id: string;
  title?: string;
  initial: ChatMessage[];
  fresh?: boolean;
  caseId?: string;
  caseTitle?: string;
}) {
  // the chat lives in the store: this page only shows it, and leaving the page does not stop an answer
  const chat = useChatStore((s) => s.open)(id, initial, caseId);
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
  // what the agent read in full (a citation of anything else is unverified), and every source the answers cite, in
  // order of first citation: its place is its number
  const { loaded, cites } = useMemo(() => {
    const loaded = new Set<string>();
    const cites: Cite[] = [];
    for (const m of messages)
      for (const p of m.parts) {
        if (p.type === "tool-read" && p.state === "output-available")
          for (const c of p.output) loaded.add(`s:${c.chunkId}`);
        if (p.type === "tool-asOf" && p.state === "output-available" && p.output) {
          loaded.add(`s:${p.output.chunk.chunkId}`);
          for (const ch of p.output.changes) if (ch.byChunk != null) loaded.add(`s:${ch.byChunk}`); // its clause was shown
        }
        if (p.type === "tool-fileRead" && p.state === "output-available")
          for (const f of readFiles(p.output)) {
            loaded.add(`f:${f.file}`);
            for (const c of f.chunks) loaded.add(`c:${c.chunk}`);
          }
        if (p.type === "text" && m.role === "assistant")
          for (const x of p.text.matchAll(CITE)) {
            const c = citeOf(x);
            if (!cites.some((y) => y.key === c.key)) cites.push(c);
          }
      }
    return { loaded, cites };
  }, [messages]);
  const numbers = useMemo(() => new Map(cites.map((c, i) => [c.key, i + 1])), [cites]);

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
    send(id, text, caseId);
    // a fresh chat takes its own URL on its first message; Next syncs its router with pushState (no request)
    if (fresh && !location.pathname.endsWith(id)) history.pushState(null, "", `${location.pathname}/${id}`); // /chats → /chats/<id>
  };

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (!href?.startsWith("#cite:"))
          return (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          );
        let c: Cite;
        try {
          c = JSON.parse(decodeURIComponent(href.slice(6)));
        } catch {
          return <>{children}</>;
        }
        const ok = c.kind === "page" || loaded.has(c.key);
        const chip = (
          <button
            type="button"
            onClick={() => show(c)}
            className={cn(
              "mx-0.5 inline-flex max-w-64 items-center gap-1 rounded-md border px-1.5 py-px align-baseline font-sans text-xs font-medium transition-colors",
              ok
                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                : "border-dashed border-destructive/50 text-destructive",
              open?.key === c.key && "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {!ok && <TriangleAlert className="size-3 shrink-0" />}
            <span className="tabular-nums">{numbers.get(c.key)}</span>
            <span className="truncate font-normal opacity-80">{c.label}</span>
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
    [loaded, numbers, open, show],
  );

  const panel = <CitationPanel open={open} cites={cites} caseId={caseId} onPick={show} onBack={() => setOpen(null)} />;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3" style={{ borderBottomWidth: empty ? 0 : 1 }}>
          <SidebarTrigger />
          {caseId && caseTitle && (
            <>
              <Link
                href={`/cases/${caseId}`}
                className="max-w-48 shrink-0 truncate text-sm text-muted-foreground hover:text-foreground"
              >
                {caseTitle}
              </Link>
              {!empty && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            </>
          )}
          {!empty && (
            <motion.h1
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="min-w-0 flex-1 truncate text-sm font-medium"
            >
              {title ??
                messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text")?.text ??
                "New chat"}
            </motion.h1>
          )}
          {!empty && !caseId && !busy && <MoveToCase chatId={id} />}
          {!empty && (
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="xl:hidden">
                  <BookMarked /> Citations {cites.length > 0 && <Badge variant="secondary">{cites.length}</Badge>}
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full gap-0 p-0 sm:max-w-xl xl:hidden">
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
                  {caseId ? "What would you like to know about this case?" : "What would you like to research?"}
                </h2>
                <p className="text-muted-foreground">
                  {caseId
                    ? "Answers read in the light of the case's facts, drawn from the Constitution and Acts of Sri Lanka."
                    : "Answers drawn from the Constitution and Acts of Sri Lanka, each with its citation."}
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
              draftKey={fresh ? (caseId ? `new:${caseId}` : "new") : id}
              placeholder={caseId ? "Ask about this case…" : undefined}
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
                  {(caseId ? CASE_EXAMPLES : EXAMPLES).map((q) => (
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
      {!empty && (
        <aside
          className={cn("hidden shrink-0 border-l bg-sidebar transition-[width] xl:block", open ? "w-[34rem]" : "w-96")}
        >
          {panel}
        </aside>
      )}
    </div>
  );
}

/** "Move to case": a quick chat goes into one of the user's cases and opens there (the agent gets the case's facts
 *  from the next question on). */
function MoveToCase({ chatId }: { chatId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const cases = useQuery(trpc.case.list.queryOptions(undefined, { enabled: open }));
  const move = useMutation(
    trpc.chat.move.mutationOptions({
      onSuccess: ({ caseId }) => {
        router.push(`/cases/${caseId}/chats/${chatId}`);
        router.refresh();
      },
    }),
  );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={move.isPending}>
          {move.isPending ? <Loader2 className="animate-spin" /> : <FolderInput />}
          <span className="hidden sm:inline">Move to case</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Move this chat to a case</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {cases.isPending && <DropdownMenuItem disabled>Loading cases…</DropdownMenuItem>}
        {cases.isError && <DropdownMenuItem disabled>Could not load your cases</DropdownMenuItem>}
        {cases.data?.length === 0 && <DropdownMenuItem disabled>No cases yet</DropdownMenuItem>}
        <div className="max-h-72 overflow-y-auto">
          {cases.data?.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => move.mutate({ chatId, caseId: c.id })}>
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
  caseId,
  onPick,
  onBack,
}: {
  open: Cite | null;
  cites: Cite[];
  caseId?: string;
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
              The provisions and case documents an answer cites appear here.
            </div>
          ) : (
            <ol className="flex flex-col gap-1">
              {cites.map((c, i) => (
                <li key={c.key}>
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
  const number = cites.findIndex((c) => c.key === open.key) + 1;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="All citations">
          <ArrowLeft />
        </Button>
        <h2 className="truncate text-sm font-medium">
          {number > 0 && <span className="mr-1.5 text-muted-foreground tabular-nums">{number}</span>}
          {open.label}
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        {open.kind === "law" ? (
          <LawSource key={open.key} chunkId={open.chunkId} />
        ) : open.kind === "file" ? (
          <FileSource key={open.key} caseId={caseId} fileId={open.fileId} n={open.n} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            An older citation of a file page. Open the case's files to see it.
          </p>
        )}
      </div>
    </div>
  );
}

/** A fileRead output's files and passages; [] for an error, and for an old chat's read (pages, before passages). */
function readFiles(o: unknown) {
  return o && typeof o === "object" && "files" in o && Array.isArray(o.files)
    ? (o.files as { file: string; chunks: { chunk: string }[] }[])
    : [];
}
