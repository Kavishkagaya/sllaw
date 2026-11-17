"use client";
import { useChat } from "@ai-sdk/react";
import type { ChatMessage } from "@sllaw/api";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  BookMarked,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  Landmark,
  TriangleAlert,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { BrandMark } from "@/components/brand";
import { CasePicker } from "@/components/chat/case-picker";
import { Composer } from "@/components/composer";
import { PapersDrawing } from "@/components/drawn";
import { SafeImg } from "@/components/safe-img";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lawName, shortPin, titleCase } from "@/lib/law";
import { cn } from "@/lib/utils";
import { type Cite, useChatStore } from "@/stores/chat-store";
import { useTRPC } from "@/trpc/client";
import { CaseChange } from "./case-change";
import { FileSource, LawSource, TONE, type Tone } from "./source-view";
import { splitAnswer, Trail, type TrailSource } from "./trail";

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
/** Laws in the oxblood tint, the user's own case files neutral (an old page citation is a case file too). */
const toneOf = (c: Cite): Tone => (c.kind === "law" ? "law" : "file");
// while an answer streams, a citation the model has not closed yet ("[[8123|s. 2") is a "citing…" chip, never raw text
const PARTIAL = /\[\[[^\]\n]*\]?$|\[$/;
const toLinks = (s: string, live = false) =>
  (live ? s.replace(PARTIAL, "[citing…](#citing)") : s).replace(CITE, (...m) => {
    const c = citeOf(m as unknown as RegExpMatchArray);
    // ( and ) too: encodeURIComponent keeps them, and a label cut short ("Order (CHINA HARBOR…") leaves one unbalanced,
    // which ends the markdown link early and shows it raw (chat-regulations s2 walk)
    return `[${c.label}](#cite:${encodeURIComponent(JSON.stringify(c)).replace(/[()]/g, (p) => (p === "(" ? "%28" : "%29"))})`;
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
  const draftKey = fresh ? (caseId ? `new:${caseId}` : "new") : id;
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
  const open = useChatStore((s) => s.cite[id] ?? null);
  const pick = useChatStore((s) => s.pick);
  const [sheet, setSheet] = useState(false);
  const [side, setSide] = useState<"right" | "bottom">("right");
  // below xl the panel is a sheet (from the bottom on a phone); at xl it is always beside the thread
  const show = useCallback(
    (c: Cite) => {
      pick(id, c);
      setSide(matchMedia("(min-width: 40rem)").matches ? "right" : "bottom");
      setSheet(!matchMedia("(min-width: 80rem)").matches);
    },
    [id, pick],
  );
  // a step's chip in the trail opens its source like a citation does
  const openSource = useCallback(
    (t: TrailSource) =>
      show(
        t.kind === "law"
          ? { kind: "law", key: `s:${t.chunkId}`, label: t.label, chunkId: t.chunkId }
          : { kind: "file", key: `c:${t.fileId}:${t.n}`, label: t.label, fileId: t.fileId, n: t.n },
      ),
    [show],
  );
  // what the agent read in full (a citation of anything else is unverified), and every source the answers cite, in
  // order of first citation: its place is its number
  // `known`: every law section the agent's tools returned (search, read, amendment check), with its law and text, so the
  // Sources list groups a citation the moment it lands, with no request (a request per citation made each one late)
  const { loaded, cites, known } = useMemo(() => {
    const loaded = new Set<string>();
    const cites: Cite[] = [];
    const known = new Map<number, Known>();
    const add = (c: Known) => known.set(c.chunkId, { ...known.get(c.chunkId), ...c });
    for (const m of messages)
      for (const p of m.parts) {
        if (p.type === "tool-search" && p.state === "output-available" && Array.isArray(p.output))
          for (const c of p.output) {
            if ("passage" in c) {
              add({ ...c, text: c.passage });
              loaded.add(`s:${c.chunkId}`); // a judgment hit comes whole: it was read
            } else add(c);
          }
        if (p.type === "tool-read" && p.state === "output-available" && Array.isArray(p.output))
          for (const c of p.output) {
            loaded.add(`s:${c.chunkId}`);
            add(c);
          }
        if (p.type === "tool-asOf" && p.state === "output-available" && p.output) {
          add(p.output.chunk);
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
    return { loaded, cites, known };
  }, [messages]);
  const numbers = useMemo(() => new Map(cites.map((c, i) => [c.key, i + 1])), [cites]);

  // follow the newest text only while the lawyer is at the end of the thread; scrolled up to read, the view stays
  // put and "Jump to latest" takes them back (chat-stable)
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  // only the lawyer scrolling up lets go: text arriving after our own scroll leaves a gap too, and must not. The wheel,
  // a touch drag and the keys let go before the scroll happens, so the next text does not pull them back down
  const letGo = () => {
    stick.current = false;
    setAway(true);
  };
  const onScroll = () => {
    const s = scroller.current;
    if (!s) return;
    if (s.scrollHeight - s.scrollTop - s.clientHeight < 48) stick.current = true;
    else if (s.scrollTop < lastTop.current) stick.current = false;
    lastTop.current = s.scrollTop;
    setAway(!stick.current);
  };
  const scrollIntent = {
    onScroll,
    onWheel: (e: React.WheelEvent) => e.deltaY < 0 && letGo(),
    onTouchMove: letGo,
    onKeyDown: (e: React.KeyboardEvent) => ["ArrowUp", "PageUp", "Home"].includes(e.key) && letGo(),
  };
  // glide to the end instead of jumping: each frame closes a fifth of the distance, so new text and "Jump to latest"
  // scroll smoothly; one loop at a time; it stops when the lawyer scrolls up (stick off) and is instant under reduced motion
  const glide = useRef(0);
  const follow = useCallback(() => {
    const s = scroller.current;
    if (!s) return;
    cancelAnimationFrame(glide.current);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      s.scrollTop = s.scrollHeight;
      return;
    }
    const step = () => {
      const left = s.scrollHeight - s.clientHeight - s.scrollTop;
      if (left < 1 || !stick.current) return;
      s.scrollTop += Math.max(1, left * 0.2);
      glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(glide.current), []);
  const toEnd = () => {
    stick.current = true;
    setAway(false);
    follow();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the trigger, not an input
  useEffect(() => {
    if (stick.current) follow();
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  // when the question went out: the working timer runs from it across the placeholder and the answer
  const [since, setSince] = useState(0);
  useEffect(() => {
    if (busy) setSince(Date.now());
  }, [busy]);
  const empty = messages.length === 0;
  const ask = (text: string, playbook?: string) => {
    stick.current = true;
    send(id, text, caseId, playbook);
    // a fresh chat takes its own URL on its first message; Next syncs its router with pushState (no request)
    if (fresh && !location.pathname.endsWith(id)) history.pushState(null, "", `${location.pathname}/${id}`); // /chats → /chats/<id>
  };

  // what the citation chips read (their numbers, whether read, the open action): a context, so the renderers Streamdown
  // gets stay the same object for the whole stream and its blocks (and their word fade) are not redrawn per word
  // loaded and numbers are rebuilt per streamed token but only ever grow: keep one object until they do, so the chips
  // (context consumers) in earlier answers are not re-rendered per token
  const stable = useRef({ loaded, numbers });
  if (loaded.size !== stable.current.loaded.size || numbers.size !== stable.current.numbers.size)
    stable.current = { loaded, numbers };
  const grown = stable.current;
  const citeInfo = useMemo(
    () => ({ chatId: id, loaded: grown.loaded, numbers: grown.numbers, show }),
    [id, grown, show],
  );

  const panel = (
    <CitationPanel
      open={open}
      cites={cites}
      loaded={loaded}
      known={known}
      caseId={caseId}
      onPick={show}
      onBack={() => pick(id, null)}
    />
  );

  return (
    <CiteInfo.Provider value={citeInfo}>
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="flex h-12 shrink-0 items-center gap-2 bg-card px-3"
            style={{ borderBottomWidth: empty ? 0 : 1 }}
          >
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
            {!empty && (
              <Sheet open={sheet} onOpenChange={setSheet}>
                <SheetTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full border-law-border bg-law text-law-ink hover:bg-law-mark xl:hidden"
                  >
                    <BookMarked /> Sources {cites.length > 0 && <span className="tabular-nums">{cites.length}</span>}
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side={side}
                  className={cn(
                    "gap-0 p-0 xl:hidden",
                    side === "bottom" ? "max-h-[85svh] rounded-t-2xl" : "w-full sm:max-w-xl",
                  )}
                >
                  {side === "bottom" && (
                    <span aria-hidden className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-input" />
                  )}
                  <SheetTitle className="sr-only">Sources</SheetTitle>
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
                  <BrandMark className="mx-auto mb-4 size-9" />
                  <h2 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
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
                  ref={scroller}
                  {...scrollIntent}
                  className="min-h-0 flex-1 overflow-y-auto"
                >
                  <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
                    {messages.map((m) =>
                      m.role === "user" ? (
                        <Question key={m.id} parts={m.parts} />
                      ) : (
                        // no fade: it takes the place of the placeholder below, which looks the same (chat-stable)
                        <div key={m.id}>
                          <Answer
                            parts={m.parts}
                            live={busy && m.id === messages.at(-1)?.id}
                            components={components}
                            caseId={caseId}
                            loaded={loaded}
                            onOpen={openSource}
                            since={since}
                          />
                        </div>
                      ),
                    )}
                    {/* until the answer's own message arrives; then that one shows it (one working box, chat-stable) */}
                    {busy && messages.at(-1)?.role === "user" && (
                      <Answer
                        parts={[]}
                        live
                        components={components}
                        caseId={caseId}
                        loaded={loaded}
                        onOpen={openSource}
                        since={since}
                      />
                    )}
                    {error &&
                      (isLimit(error.message) ? (
                        <Alert>
                          <Gauge />
                          <AlertDescription>
                            {error.message}{" "}
                            <Link href="/usage" className="font-medium underline underline-offset-4">
                              See your usage
                            </Link>
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <Alert variant="destructive">
                          <TriangleAlert />
                          <AlertDescription>Something went wrong: {error.message}</AlertDescription>
                        </Alert>
                      ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* the same box in both states: layout animates it from the middle to the bottom */}
            <motion.div
              layout
              transition={SPRING}
              className={cn("relative mx-auto w-full px-4", empty ? "max-w-2xl" : "max-w-3xl pb-4")}
            >
              {!empty && away && (
                <Button
                  size="icon"
                  onClick={toEnd}
                  aria-label="Jump to latest"
                  title="Jump to latest"
                  className="absolute -top-14 left-1/2 size-11 -translate-x-1/2 rounded-full shadow-lg ring-4 ring-background sm:size-10"
                >
                  <ArrowDown className="size-5" />
                </Button>
              )}
              <UsageHint status={status} />
              <Composer
                draftKey={draftKey}
                placeholder={caseId ? "Ask about this case…" : undefined}
                inCase={!!caseId}
                caseId={caseId}
                onSend={ask}
                onStop={() => stop(id)}
                busy={busy}
                autoFocus={empty}
                chip={
                  <CasePicker
                    caseId={caseId}
                    caseTitle={caseTitle}
                    draftKey={empty && fresh ? draftKey : undefined}
                    chatId={empty && fresh ? undefined : id}
                    disabled={busy}
                  />
                }
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
                        className="rounded-lg border bg-card p-3 text-left shadow-xs text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
            className={cn(
              "hidden shrink-0 border-l bg-sidebar transition-[width] xl:block",
              open ? "w-[34rem]" : "w-96",
            )}
          >
            {panel}
          </aside>
        )}
      </div>
    </CiteInfo.Provider>
  );
}

/** The lawyer's message: rendered once (memo on its parts, which the SDK keeps for every message but the newest). */
const Question = memo(function Question({ parts }: { parts: ChatMessage["parts"] }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="ml-auto flex max-w-[85%] flex-col items-end gap-1.5"
    >
      {parts.map((p, i) =>
        p.type === "data-playbook" ? (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 rounded-full bg-law px-2.5 py-0.5 text-[11.5px] text-law-ink"
          >
            <BookOpen className="size-3" /> {p.data.name}
          </span>
        ) : null,
      )}
      <div className="rounded-[12px_12px_4px_12px] bg-ink px-4 py-3 text-[15px] leading-normal whitespace-pre-wrap text-paper">
        {parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
      </div>
    </motion.div>
  );
});

// new words fade in while an answer streams (Streamdown's animate plugin; its keyframes come from streamdown/styles.css)
const ANIMATE = { animation: "fadeIn", sep: "word", duration: 200 } as const;

/** An earlier answer never renders again (its parts are the same object, it is not live): props that change per token
 *  (loaded, since) are ignored for it. Only the streaming answer updates. */
const Answer = memo(AnswerView, (a, b) =>
  !a.live && !b.live
    ? a.parts === b.parts && a.caseId === b.caseId && a.onOpen === b.onOpen
    : a.parts === b.parts && a.live === b.live && a.loaded === b.loaded && a.since === b.since && a.caseId === b.caseId,
);

function AnswerView({
  parts,
  live,
  components,
  caseId,
  loaded,
  onOpen,
  since,
}: {
  parts: ChatMessage["parts"];
  live: boolean;
  components: Record<string, unknown>;
  caseId?: string;
  loaded: Set<string>;
  onOpen: (s: TrailSource) => void;
  since?: number;
}) {
  const { trail, answer } = splitAnswer(parts, live);
  // once the answer has started, the trail stays folded: a later search does not open it again (chat-stable)
  const started = useRef(false);
  if (answer.some((p) => p.type === "text" && p.text)) started.current = true;
  const writing = started.current;
  // the agent's changes to the case office, (docs/APP.md, Case office)
  const changes = parts.flatMap((p) =>
    p.type === "tool-caseUpdate" && p.state === "output-available" && typeof p.output === "object" && p.output.summary
      ? [p.output]
      : [],
  );
  // this answer's citations: how many were read (checked) and how many were not
  const keys = new Set<string>();
  for (const p of answer)
    if (p.type === "text")
      for (const x of p.text.matchAll(CITE)) if (citeOf(x).kind !== "page") keys.add(citeOf(x).key);
  const unread = [...keys].filter((k) => !loaded.has(k)).length;
  return (
    <article className="flex flex-col gap-3.5 rounded-xl border bg-card px-4 py-4 shadow-xs sm:px-6 sm:py-5">
      {(trail.length > 0 || (live && !writing)) && (
        <div className="flex items-start gap-2.5">
          {!(live && !writing) && <BrandMark className="mt-2 size-5" />}
          <div className="min-w-0 flex-1">
            <Trail parts={trail} live={live && !writing} since={since} onOpen={onOpen} />
          </div>
        </div>
      )}
      {answer.map(
        (p, i) =>
          p.type === "text" && (
            <Streamdown
              key={i}
              className="md text-[15px]"
              components={components as never}
              isAnimating={live}
              animated={live ? ANIMATE : false}
            >
              {toLinks(p.text, live)}
            </Streamdown>
          ),
      )}
      {caseId && changes.map((c, i) => <CaseChange key={i} caseId={caseId} summary={c.summary} />)}
      {keys.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-dashed pt-3 text-[12.5px] text-muted-foreground">
          {keys.size - unread > 0 && (
            <span className="flex items-center gap-1.5 text-ok">
              <Check className="size-3.5" />
              {keys.size - unread} {keys.size - unread === 1 ? "citation" : "citations"} checked
            </span>
          )}
          {unread > 0 && (
            <span className="flex items-center gap-1.5 text-unverified-ink">
              <TriangleAlert className="size-3.5" />
              {unread} not verified
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** A citation's group in the list: its law or case file, named once, with each cited place under it. */
/** A law section as the agent's tools returned it (search hit, read, amendment check). */
type Known = {
  chunkId: number;
  docKey: string;
  title: string | null;
  label: string | null;
  path: string | null;
  text: string;
};

type Group = {
  key: string;
  law: boolean;
  title: string;
  sub: string | null;
  items: { c: Cite; n: number; where: string; snippet?: string }[];
};

/** The model's label minus the document's name: "PLAINT, p. 2" → "p. 2"; "s. 22, Rent" → "s. 22". */
const placeOf = (label: string, law: boolean) => {
  const bits = label.split(",").map((b) => b.trim());
  if (bits.length < 2) return label;
  return law ? bits[0]! : bits[bits.length - 1]!;
};

function useGroups(cites: Cite[], known: Map<number, Known>, caseId?: string): Group[] {
  const trpc = useTRPC();
  // only a citation the agent's tools never returned (unverified) is looked up
  const laws = useQueries({
    queries: cites.map((c) =>
      trpc.corpus.chunk.queryOptions(
        { chunkId: c.kind === "law" ? c.chunkId : 0 },
        { enabled: c.kind === "law" && !known.has(c.chunkId) },
      ),
    ),
  });
  const hasFiles = cites.some((c) => c.kind === "file");
  const files = useQuery(trpc.case.files.queryOptions({ caseId: caseId ?? "" }, { enabled: !!caseId && hasFiles }));
  const groups = new Map<string, Group>();
  cites.forEach((c, i) => {
    let key: string, title: string, sub: string | null, where: string, snippet: string | undefined;
    if (c.kind === "law") {
      const k = known.get(c.chunkId);
      const d = laws[i]?.data;
      const v = k
        ? { chunk: k, doc: null }
        : d
          ? { chunk: { ...d.chunk, title: d.doc?.title ?? d.chunk.title }, doc: d.doc }
          : undefined;
      // not known yet: it joins its law's group once the law is known (a group of its own first made the count jump)
      if (!v && laws[i]?.isPending) return;
      key = v ? `d:${v.chunk.docKey}` : c.key;
      title = v
        ? titleCase(v.doc?.title ?? v.chunk.title ?? v.chunk.docKey)
        : c.label.split(",").slice(1).join(",").trim() || "Law";
      sub = v ? lawName(v.chunk.docKey) : null;
      where = (v && shortPin(v.chunk.path, v.chunk.label)) || placeOf(c.label, true);
      snippet = v?.chunk.text;
    } else if (c.kind === "file") {
      const f = files.data?.find((x) => x.id === c.fileId);
      key = `f:${c.fileId}`;
      title = f ? (((f.meta ?? {}) as { title?: string }).title ?? f.name) : c.label.split(",")[0]!;
      sub = "Case file";
      where = c.n == null ? "Whole file" : placeOf(c.label, false);
    } else {
      key = c.key;
      title = c.label;
      sub = "Older citation";
      where = c.label;
    }
    const g = groups.get(key) ?? { key, law: c.kind === "law", title, sub, items: [] };
    g.items.push({ c, n: i + 1, where, snippet });
    groups.set(key, g);
  });
  return [...groups.values()];
}

/** What a citation chip needs from its chat (Chat provides it). */
const CiteInfo = createContext<{
  chatId: string;
  loaded: Set<string>;
  numbers: Map<string, number>;
  show: (c: Cite) => void;
}>({ chatId: "", loaded: new Set(), numbers: new Map(), show: () => {} });

/** A link in an answer: a citation becomes its numbered chip (it opens the source in the panel), anything else an
 *  ordinary link out. */
function CiteLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { chatId: id, loaded, numbers, show } = useContext(CiteInfo);
  if (href === "#citing")
    return (
      <span className="mx-0.5 inline-flex animate-pulse items-center rounded-[5px] border border-dashed px-1.5 align-[1px] font-sans text-[12.5px] leading-5 text-muted-foreground">
        citing…
      </span>
    );
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
  const tone = toneOf(c);
  const chip = (
    <CiteButton
      chatId={id}
      citeKey={c.key}
      on={ok ? TONE[tone].on : undefined}
      onClick={() => show(c)}
      aria-label={`Citation ${numbers.get(c.key)}: ${c.label}${ok ? "" : ", not verified"}`}
      className={cn(
        "mx-0.5 inline-flex max-w-72 cursor-pointer items-center gap-1 rounded-[5px] border px-1.5 align-[1px] font-sans text-[12.5px] leading-5 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        !ok ? "border-dashed border-unverified-border bg-unverified text-unverified-ink" : TONE[tone].chip,
      )}
    >
      <span className="shrink-0 tabular-nums opacity-80">
        {!ok ? <TriangleAlert className="inline size-3 -translate-y-px" /> : tone === "file" ? "▤" : "§"}{" "}
        {numbers.get(c.key)}
      </span>
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <span className="truncate">{c.label}</span>
    </CiteButton>
  );
  return ok ? (
    chip
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>Not verified: Hulft did not read this in this chat</TooltipContent>
    </Tooltip>
  );
}

// Streamdown's renderers: one object for every answer, never rebuilt (a new one redraws every block)
const components = { img: SafeImg, a: CiteLink };

/** A citation chip in an answer: solid while its source is open in this chat's panel. It reads the open citation from
 *  the store itself, so it updates even where Streamdown keeps a rendered block. */
function CiteButton({
  chatId,
  citeKey,
  on,
  className,
  ...props
}: React.ComponentProps<"button"> & { chatId: string; citeKey: string; on?: string }) {
  const open = useChatStore((s) => s.cite[chatId]?.key === citeKey);
  return <button type="button" aria-pressed={open} className={cn(className, open && on)} {...props} />;
}

function CitationPanel({
  open,
  cites,
  loaded,
  known,
  caseId,
  onPick,
  onBack,
}: {
  open: Cite | null;
  cites: Cite[];
  loaded: Set<string>;
  known: Map<number, Known>;
  caseId?: string;
  onPick: (c: Cite) => void;
  onBack: () => void;
}) {
  const groups = useGroups(cites, known, caseId);
  if (!open)
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-12 pl-4 xl:pr-4">
          <h2 className="label-mono text-[10.5px] text-muted-foreground">Sources</h2>
          {cites.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {cites.length} in {groups.length} {groups.length === 1 ? "source" : "sources"}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {!cites.length ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
              <PapersDrawing className="mb-2" />
              The law and the case papers an answer cites appear here.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((g) => {
                const Icon = g.law ? Landmark : FileText;
                return (
                  <section key={g.key} className="overflow-hidden rounded-lg border bg-card shadow-xs">
                    <header className="flex items-start gap-2.5 border-b px-3 py-2.5">
                      <span
                        className={cn(
                          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border",
                          TONE[g.law ? "law" : "file"].soft,
                        )}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-[15px] leading-snug font-semibold">{g.title}</h3>
                        {g.sub && <p className="text-xs text-muted-foreground">{g.sub}</p>}
                      </div>
                    </header>
                    <ol>
                      {g.items.map(({ c, n, where, snippet }) => {
                        const ok = c.kind === "page" || loaded.has(c.key);
                        return (
                          <li key={c.key} className="border-b last:border-b-0">
                            <button
                              type="button"
                              onClick={() => onPick(c)}
                              className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60"
                            >
                              <span
                                className={cn(
                                  "mt-px flex h-5 w-6 shrink-0 items-center justify-center rounded border px-1 text-[11px] font-medium tabular-nums",
                                  TONE[toneOf(c)].soft,
                                )}
                              >
                                {n}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate font-medium">{where}</span>
                                  {!ok && (
                                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-unverified-ink">
                                      <TriangleAlert className="size-3" /> not verified
                                    </span>
                                  )}
                                </span>
                                {snippet && (
                                  <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                                    {snippet}
                                  </span>
                                )}
                              </span>
                              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  const at = cites.findIndex((c) => c.key === open.key);
  const prev = at > 0 ? cites[at - 1] : undefined;
  const next = at >= 0 && at < cites.length - 1 ? cites[at + 1] : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b pr-12 pl-2 xl:pr-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft /> All
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          {at >= 0 && (
            <span
              className={cn(
                "flex h-5 min-w-5 shrink-0 items-center justify-center rounded border px-1 text-[11px] tabular-nums",
                TONE[toneOf(open)].on,
              )}
            >
              {at + 1}
            </span>
          )}
          <span className="truncate">{open.label}</span>
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {at + 1}/{cites.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!prev}
          onClick={() => prev && onPick(prev)}
          aria-label="Previous citation"
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!next}
          onClick={() => next && onPick(next)}
          aria-label="Next citation"
        >
          <ChevronRight />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {open.kind !== "page" && !loaded.has(open.key) && (
          <div className="m-5 mb-0 rounded-xl border border-dashed border-unverified-border bg-unverified px-4 py-3.5">
            <p className="label-mono flex items-center gap-1.5 text-[10px] text-unverified-ink">
              <TriangleAlert className="size-3" /> Not verified
            </p>
            <p className="mt-1.5 text-[15px] font-semibold">Hulft did not read this in this chat</p>
            <p className="mt-1 text-[13.5px] leading-normal text-muted-foreground">
              It may be wrong or may not exist. Check it before you rely on it.
            </p>
          </div>
        )}
        {open.kind === "law" ? (
          <LawSource key={open.key} chunkId={open.chunkId} read={loaded.has(open.key)} />
        ) : open.kind === "file" ? (
          <FileSource key={open.key} caseId={caseId} fileId={open.fileId} n={open.n} read={loaded.has(open.key)} />
        ) : (
          <p className="p-5 text-sm text-muted-foreground">
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

/** A plan limit's message (the chat route's 429 text: services/limits rules.ts, limitMessage). */
const isLimit = (m: string) => /^(You have|This case has|This file would)\b.* plan\b/.test(m);

/** Above the box once a chat limit is 80% used: how much, and the way to /usage. Read again after each answer. */
function UsageHint({ status }: { status: string }) {
  const trpc = useTRPC();
  const usage = useQuery(trpc.usage.mine.queryOptions());
  const { refetch } = usage;
  useEffect(() => {
    if (status === "ready" || status === "error") void refetch();
  }, [status, refetch]);
  const near = usage.data?.limits
    .filter((l) => l.kind === "counter" && l.max && l.used != null && l.used / l.max >= 0.8)
    .sort((a, b) => b.used! / b.max! - a.used! / a.max!)[0];
  if (!near) return null;
  const pct = Math.min(100, Math.round((near.used! / near.max!) * 100));
  return (
    <p className="mb-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
      <Gauge className="size-3.5" />
      {pct >= 100 ? "Used up" : `${pct}% used`}: {near.label.toLowerCase()}.{" "}
      <Link href="/usage" className="font-medium text-foreground underline-offset-4 hover:underline">
        Usage
      </Link>
    </p>
  );
}
