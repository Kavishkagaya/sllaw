"use client";
// A cited source in the chat's sidebar: what it is, the cited text first, then the whole document with that text
// marked. A law by its chunk id (corpus.chunk: the chunk, which laws changed it, its law's timeline; corpus.doc, the law around it, only when opened); a case
// file by its id and chunk number (case.fileChunks: the same chunks the agent read).
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, ExternalLink, FileText, History, Landmark, LocateFixed } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { lawName, pinpoint, textAs, titleCase } from "@/lib/law";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";

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
  law,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kind: string;
  title: string;
  sub?: string | null;
  law?: boolean; // a law's name in the statute serif
  children?: React.ReactNode;
}) {
  return (
    <header className="space-y-3">
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          <Icon className="size-3.5" /> {kind}
        </p>
        <h3 className={cn("text-xl leading-snug text-balance", law ? "font-law font-medium" : "font-semibold")}>
          {title}
        </h3>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  );
}

/** The colours that tell a law (an oxblood tint) from the lawyer's own file (a neutral tint), wherever a citation
 *  shows: the same in the answer and in the panel. */
export const TONE = {
  law: {
    chip: "border-law-border bg-law text-law-ink hover:bg-law-mark",
    on: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
    soft: "border-law-border bg-law text-law-ink",
    text: "text-law-ink",
    quote: "border-law-border bg-card",
    rule: "border-law-border",
    mark: "bg-law-mark ring-law-border",
  },
  file: {
    chip: "border-file-border bg-file text-file-ink hover:bg-accent",
    on: "border-foreground bg-foreground text-background hover:bg-foreground/90",
    soft: "border-file-border bg-file text-file-ink",
    text: "text-file-ink",
    quote: "border-file-border bg-card",
    rule: "border-file-border",
    mark: "bg-file ring-file-border",
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
      <blockquote
        className={cn(
          "px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap",
          tone === "law" ? "bg-law-mark font-law" : "bg-file",
        )}
      >
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
    "scroll-mt-16 rounded-md px-3 py-2 font-law text-[15px] leading-relaxed whitespace-pre-wrap transition-colors",
    on ? cn("text-foreground ring-1", TONE[tone].mark) : "text-muted-foreground",
  );
const crumb = "mb-1 font-sans text-xs font-medium text-foreground/70";

function useJump() {
  const at = useRef<HTMLElement>(null);
  return [at, () => at.current?.scrollIntoView({ block: "start", behavior: "smooth" })] as const;
}

/** The law's timeline, oldest first: enacted, every law that changed any part of it, today; the ones that changed the
 *  cited section marked. A list, not a scaled line: amendments cluster in a few years and a line overlaps them. A long
 *  history shows its first and last entries and folds the middle (never a marked one). What each change did, clause
 *  by clause, is on the Full history page (/history/<law>?c=<section>), linked from the header. */
export function AmendmentLine({
  docKey,
  chunkId,
  law,
  section,
  current,
}: {
  docKey: string;
  /** the cited section: with it, the header links to its full history */
  chunkId?: number;
  law: { by: string; title: string | null; date: string | null }[];
  section: { by: string; date: string | null }[];
  /** the cited section is an amendment from this law: its row is marked "this amendment" */
  current?: string;
}) {
  const [all, setAll] = useState(false);
  const enacted =
    docKey === "constitution" || docKey.startsWith("constitution:") ? 1978 : Number(docKey.split("/")[1]) || null;
  const mine = new Set(section.map((c) => c.by));
  const rows = [...law, ...section.filter((c) => !law.some((l) => l.by === c.by)).map((c) => ({ ...c, title: null }))]
    .map((c) => ({ ...c, name: titleCase(c.title ?? lawName(c.by)), mine: mine.has(c.by) || c.by === current }))
    .sort((p, q) => (p.date ?? "9").localeCompare(q.date ?? "9"));
  const FOLD = 6;
  const hidden = !all && rows.length > FOLD ? rows.length - 4 : 0;
  const keep = (i: number) => i < 2 || i >= rows.length - 2 || rows[i]!.mine;
  const shown = hidden ? rows.flatMap((r, i) => (keep(i) ? [r] : !keep(i - 1) ? [] : [null])) : rows;
  const hiddenCount = rows.filter((_, i) => !keep(i)).length;
  const dot = "relative z-10 mt-1.5 size-2.5 shrink-0 rounded-full border-2";
  return (
    <section aria-label="The law's timeline" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="label-mono text-[10px] text-muted-foreground">
          {rows.length
            ? `${current ? `${lawName(docKey)}: ` : ""}Amended by ${rows.length} ${rows.length === 1 ? "law" : "laws"}${current ? "" : ` · ${mine.size ? `${mine.size} changed this section` : "none changed this section"}`}`
            : "Never amended"}
        </p>
        {chunkId != null && (
          <Link
            href={`/history/${docKey}?c=${chunkId}`}
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Full history <History className="size-3.5" />
          </Link>
        )}
      </div>
      <ol className="relative space-y-1.5 before:absolute before:top-2 before:bottom-2 before:left-[4.5rem] before:w-px before:bg-border">
        {enacted && (
          <li className="flex gap-3 text-[13px]">
            <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
              {enacted}
            </span>
            <span className={cn(dot, "border-foreground bg-card")} />
            <span>Enacted</span>
          </li>
        )}
        {shown.map((r, i) =>
          r ? (
            <li key={r.by} className="flex gap-3 text-[13px]">
              <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {r.date?.slice(0, 4) ?? "—"}
              </span>
              <span className={cn(dot, r.mine ? "border-primary bg-primary" : "border-muted-foreground/60 bg-card")} />
              <span className="min-w-0 flex-1">
                <span className={r.mine ? "font-medium" : "text-muted-foreground"}>{r.name}</span>
                {r.by === current ? (
                  <span className="ml-1.5 text-xs font-medium text-primary">this amendment</span>
                ) : (
                  r.mine && <span className="ml-1.5 text-xs text-primary">changed this section</span>
                )}
              </span>
            </li>
          ) : (
            <li key={`more-${i}`} className="flex gap-3 text-[13px]">
              <span className="w-14 shrink-0" />
              <span className="w-2.5 shrink-0" />
              <button type="button" onClick={() => setAll(true)} className="text-xs text-primary hover:underline">
                {hiddenCount} more
              </button>
            </li>
          ),
        )}
        <li className="flex gap-3 text-[13px]">
          <span className="w-14 shrink-0 text-right font-mono text-xs text-primary">TODAY</span>
          <span className={cn(dot, "border-primary bg-primary")} />
          <span className="text-muted-foreground">
            {mine.size ? "In force as amended (Full history)" : "The text in force"}
          </span>
        </li>
      </ol>
    </section>
  );
}

/** What a source is and whether the agent read it: "✓ Read · in force today" in green, or nothing (the panel shows
 *  the not-verified card above). */
function ReadMark({ read, children }: { read?: boolean; children: React.ReactNode }) {
  return read ? <p className="label-mono text-[10px] text-ok">✓ Read · {children}</p> : null;
}

export function LawSource({ chunkId, read }: { chunkId: number; read?: boolean }) {
  const trpc = useTRPC();
  const view = useQuery(trpc.corpus.chunk.queryOptions({ chunkId }));
  const key = view.data?.chunk.docKey;
  // the whole law is every chunk's text: loaded only when the lawyer opens it
  const [whole, setWhole] = useState(false);
  const doc = useQuery(trpc.corpus.doc.queryOptions({ key: key ?? "" }, { enabled: !!key && whole }));
  const [at, jump] = useJump();
  if (view.isPending) return <Loading />;
  if (view.isError) return <Problem>Could not load it: {view.error.message}</Problem>;
  if (!view.data) return <Problem>This provision is no longer in the corpus.</Problem>;
  const { chunk: c, doc: info, changed, timeline, amends } = view.data;
  const where = pinpoint(c.path, c.label);
  let last: string | null = null;
  return (
    <div className="space-y-5 p-5">
      {/* the stored text is as enacted (or as in its edition): "in force" only when nothing changed it since */}
      <ReadMark read={read}>
        {amends
          ? "an amending provision"
          : changed.length
            ? `the text ${textAs(c.docKey)} · amended since`
            : "the text in force"}
      </ReadMark>
      <Head icon={Landmark} kind={lawName(c.docKey)} title={info?.title ?? c.title ?? c.docKey} sub={where} law>
        <Button asChild variant="outline" size="sm">
          {/* the same tab: the chat keeps its answer running in the store, Back returns to it */}
          <Link href={`/doc/${c.docKey}#c${c.chunkId}`}>
            Open the law <BookOpenText />
          </Link>
        </Button>
      </Head>
      <Quote label={changed.length ? `Cited text, ${textAs(c.docKey)}` : "Cited text"} tone="law">
        {c.text}
      </Quote>
      {amends ? (
        <>
          {/* an amending section: what it changes, and that law's timeline with this change marked */}
          <p className="text-sm">
            <span className="text-muted-foreground">
              {amends.kind[0]?.toUpperCase()}
              {amends.kind.slice(1)}{" "}
            </span>
            {amends.label ? `s. ${amends.label} of ` : ""}
            <span className="font-medium">{titleCase(amends.title ?? lawName(amends.docKey))}</span>
            <span className="text-muted-foreground"> ({lawName(amends.docKey)})</span>
          </p>
          <AmendmentLine
            docKey={amends.docKey}
            chunkId={amends.chunkId ?? undefined}
            law={timeline}
            section={[]}
            current={c.docKey}
          />
        </>
      ) : (
        <AmendmentLine docKey={c.docKey} chunkId={c.chunkId} law={timeline} section={changed} />
      )}
      <Whole title="The whole law" onJump={doc.isSuccess ? jump : undefined}>
        {!whole && (
          <Button variant="outline" size="sm" onClick={() => setWhole(true)}>
            <BookOpenText /> Read the whole law here
          </Button>
        )}
        {whole && doc.isPending && <Skeleton className="h-64 w-full" />}
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
export function FileSource({
  caseId,
  fileId,
  n,
  read,
}: {
  caseId?: string;
  fileId: string;
  n: number | null;
  read?: boolean;
}) {
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
      <ReadMark read={read}>your file</ReadMark>
      <Head
        icon={FileText}
        kind="Case file"
        title={f.title ?? f.name}
        sub={cited ? `Page ${cited.page}` : f.title ? f.name : null}
      >
        <Button asChild variant="outline" size="sm">
          <a href={`/cases/${caseId}/files/${f.id}`} target="_blank" rel="noopener">
            {cited ? `Open the file at page ${cited.page}` : "Open the file"} <ExternalLink />
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
