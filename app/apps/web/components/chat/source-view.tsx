"use client";
// A cited source in the chat's sidebar: what it is, the cited text first, then the whole document with that text
// marked. A law by its chunk id (corpus.chunk for the chunk and its changes, corpus.doc for the law around it); a case
// file by its id and chunk number (case.fileChunks: the same chunks the agent read).
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, FileText, History, Landmark, LocateFixed } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";

/** A law's key as people cite it: act:9/2023 → "Act No. 9 of 2023", cap:107 → "Chapter 107". */
export function lawName(key: string) {
  const [kind, rest = ""] = key.split(":");
  const [n, year] = rest.split("/");
  if (kind === "act" && year) return `Act No. ${n} of ${year}`;
  if (kind === "law" && year) return `Law No. ${n} of ${year}`;
  if (kind === "ord" && year) return `Ordinance No. ${n} of ${year}`;
  if (kind === "cap" || kind === "cap1956") return `Chapter ${rest}${kind === "cap1956" ? " (1956 ed.)" : ""}`;
  if (kind === "constitution") return "Constitution of Sri Lanka";
  return key;
}

/** The last step of a chunk's breadcrumb ("Part II › section 13 — Notice (cont.)" → "section 13 — Notice"). */
export const pinpoint = (path: string | null, label: string | null) =>
  (path
    ?.split("›")
    .pop()
    ?.replace(/\s*\(cont\.\)\s*$/, "")
    .trim() ||
    label) ??
  null;

/** pinpoint, short, for lists: "section 22 — Proceedings for ejectment." → "s. 22 — Proceedings for ejectment". */
export const shortPin = (path: string | null, label: string | null) =>
  pinpoint(path, label)
    ?.replace(/^section\s+/i, "s. ")
    .replace(/\.$/, "") ?? null;

function Loading() {
  return (
    <div className="space-y-3 p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-4 h-40 w-full" />
    </div>
  );
}
const Problem = ({ children }: { children: React.ReactNode }) => (
  <p className="p-5 text-sm text-destructive">{children}</p>
);

/** The source's name block: kind, title, where in it. */
function Head({
  icon: Icon,
  kind,
  title,
  sub,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kind: string;
  title: string;
  sub?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <header className="space-y-3">
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          <Icon className="size-3.5" /> {kind}
        </p>
        <h3 className="font-serif text-xl leading-snug font-semibold text-balance">{title}</h3>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}

/** The colours that tell a law (brass) from the user's own case file (blue), wherever a citation shows. */
export const TONE = {
  law: {
    chip: "border-brass/40 bg-brass/10 text-brass-ink hover:bg-brass/20",
    on: "border-brass bg-brass text-background hover:bg-brass/90",
    soft: "border-brass/30 bg-brass/10 text-brass-ink",
    text: "text-brass-ink",
    quote: "border-brass/30 bg-brass/5",
    rule: "border-brass/20",
    mark: "bg-brass/10 ring-brass/40",
  },
  file: {
    chip: "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
    on: "border-sky-600 bg-sky-600 text-white hover:bg-sky-600/90 dark:border-sky-500 dark:bg-sky-500",
    soft: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    text: "text-sky-700 dark:text-sky-300",
    quote: "border-sky-500/30 bg-sky-500/5",
    rule: "border-sky-500/20",
    mark: "bg-sky-500/10 ring-sky-500/40",
  },
} as const;
export type Tone = keyof typeof TONE;

/** The cited text itself, set apart. */
function Quote({ label, tone, children }: { label: string; tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <figure className={cn("overflow-hidden rounded-lg border", t.quote)}>
      <figcaption className={cn("border-b px-4 py-2 text-[11px] font-medium tracking-wider uppercase", t.rule, t.text)}>
        {label}
      </figcaption>
      <blockquote className="px-4 py-3 font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
        {children}
      </blockquote>
    </figure>
  );
}

/** "In the Act": the whole document below the fold, the cited part marked, with a jump to it. */
function Whole({ title, onJump, children }: { title: string; onJump?: () => void; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h4>
        {onJump && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onJump}>
            <LocateFixed /> Go to cited text
          </Button>
        )}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

const part = (on: boolean, tone: Tone) =>
  cn(
    "scroll-mt-16 rounded-md px-3 py-2 font-serif text-[15px] leading-relaxed whitespace-pre-wrap transition-colors",
    on ? cn("text-foreground ring-1", TONE[tone].mark) : "text-muted-foreground",
  );
const crumb = "mb-1 font-sans text-xs font-medium text-foreground/70";

function useJump() {
  const at = useRef<HTMLElement>(null);
  return [at, () => at.current?.scrollIntoView({ block: "start", behavior: "smooth" })] as const;
}

function Changes({
  changes,
  date,
}: {
  changes: {
    date: string | null;
    kind: string;
    by: string;
    byTitle: string | null;
    byLabel: string | null;
    clause: string;
  }[];
  date: string;
}) {
  const [open, setOpen] = useState(false);
  const years = [...new Set(changes.map((c) => c.date?.slice(0, 4)).filter(Boolean))];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card shadow-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-accent/50">
        <History className="size-4 shrink-0 text-brass" />
        <span className="flex-1">
          <span className="font-medium">
            Amended {changes.length} {changes.length === 1 ? "time" : "times"}
          </span>
          <span className="text-muted-foreground">
            {years.length ? ` · ${years.join(", ")}` : ""} · up to {date}
          </span>
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="relative space-y-4 border-t px-4 py-4">
          {changes.map((ch, i) => (
            <li key={i} className="relative pl-5">
              <span className="absolute top-1.5 left-0 size-2 rounded-full bg-brass" />
              {i < changes.length - 1 && (
                <span className="absolute top-4 bottom-[-1.25rem] left-[3.5px] w-px bg-border" />
              )}
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{ch.byTitle ?? ch.by}</span>
                {ch.byLabel && <span className="text-muted-foreground">s. {ch.byLabel}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="capitalize">{ch.kind}</span>
                {ch.date && ` · ${ch.date}`}
              </p>
              {ch.clause && (
                <p className="mt-1.5 line-clamp-4 font-serif text-[13px] leading-relaxed text-muted-foreground">
                  {ch.clause}
                </p>
              )}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LawSource({ chunkId }: { chunkId: number }) {
  const trpc = useTRPC();
  const view = useQuery(trpc.corpus.chunk.queryOptions({ chunkId }));
  const key = view.data?.chunk.docKey;
  const doc = useQuery(trpc.corpus.doc.queryOptions({ key: key ?? "" }, { enabled: !!key }));
  const [at, jump] = useJump();
  if (view.isPending) return <Loading />;
  if (view.isError) return <Problem>Could not load it: {view.error.message}</Problem>;
  if (!view.data) return <Problem>This provision is no longer in the corpus.</Problem>;
  const { chunk: c, doc: info, changes, later, date } = view.data;
  const where = pinpoint(c.path, c.label);
  let last: string | null = null;
  return (
    <div className="space-y-5 p-5">
      <Head icon={Landmark} kind={lawName(c.docKey)} title={info?.title ?? c.title ?? c.docKey} sub={where}>
        <Button asChild variant="outline" size="sm">
          <a href={`/doc/${c.docKey}#c${c.chunkId}`} target="_blank" rel="noopener">
            Open the law <ExternalLink />
          </a>
        </Button>
        {info?.sourceUrl && (
          <Button asChild variant="ghost" size="sm">
            <a href={info.sourceUrl} target="_blank" rel="noreferrer">
              Official PDF <ExternalLink />
            </a>
          </Button>
        )}
      </Head>
      <Quote label="Cited text, as enacted" tone="law">
        {c.text}
      </Quote>
      {changes.length > 0 && <Changes changes={changes} date={date} />}
      {later.length > 0 && (
        <p className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Changed after {date}: </span>
          {later.map((l) => `${l.by} ${l.kind} (${l.date})`).join("; ")}
        </p>
      )}
      <Whole title="The whole law" onJump={doc.isSuccess ? jump : undefined}>
        {doc.isPending && <Skeleton className="h-64 w-full" />}
        {doc.isError && <Problem>Could not load the law: {doc.error.message}</Problem>}
        {doc.data?.chunks.map((x) => {
          // one heading per provision: its continuation chunks go under it
          const head = pinpoint(x.path, null);
          const show = head && head !== last;
          last = head;
          return (
            <section key={x.id} ref={x.id === c.chunkId ? at : undefined} className={part(x.id === c.chunkId, "law")}>
              {show && <p className={crumb}>{head}</p>}
              {x.text}
            </section>
          );
        })}
      </Whole>
    </div>
  );
}

/** A case file, whole, page by page; n the cited chunk (null: the file itself was cited). */
export function FileSource({ caseId, fileId, n }: { caseId?: string; fileId: string; n: number | null }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.case.fileChunks.queryOptions({ caseId: caseId ?? "", fileId }, { enabled: !!caseId }));
  const [at, jump] = useJump();
  if (!caseId) return <Problem>This file belongs to a case: open the chat in its case to see it.</Problem>;
  if (q.isPending) return <Loading />;
  if (q.isError) return <Problem>Could not load the file: {q.error.message}</Problem>;
  const f = q.data;
  const cited = f.chunks.find((c) => c.n === n);
  let page = 0;
  return (
    <div className="space-y-5 p-5">
      <Head
        icon={FileText}
        kind="Case file"
        title={f.title ?? f.name}
        sub={cited ? `Page ${cited.page}` : f.title ? f.name : null}
      >
        <Button asChild variant="outline" size="sm">
          <a href={`/cases/${caseId}/files/${f.id}`} target="_blank" rel="noopener">
            Open the file <ExternalLink />
          </a>
        </Button>
      </Head>
      {cited && (
        <Quote label={`Cited passage · page ${cited.page}`} tone="file">
          {cited.text}
        </Quote>
      )}
      <Whole title="The whole file" onJump={cited ? jump : undefined}>
        {!f.chunks.length && <p className="text-sm text-muted-foreground">This file has no text.</p>}
        {f.chunks.map((c) => {
          const head = c.page !== page;
          page = c.page;
          return (
            <div key={c.n}>
              {head && (
                <p className="mt-3 mb-1 flex items-center gap-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  Page {c.page} <span className="h-px flex-1 bg-border" />
                </p>
              )}
              <section ref={c.n === n ? at : undefined} className={part(c.n === n, "file")}>
                {c.text}
              </section>
            </div>
          );
        })}
      </Whole>
    </div>
  );
}
