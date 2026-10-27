"use client";
// A cited source in the chat's sidebar: the whole document, scrolled to the cited chunk and with it highlighted. A law
// by its chunk id (corpus.chunk for the chunk and its changes, corpus.doc for the law around it); a case file by its
// id and chunk number (case.fileChunks: the same chunks the agent read).
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";

/** Scrolls the highlighted chunk into view once it is on screen. */
function useScrollTo(ready: boolean) {
  const at = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ready) at.current?.scrollIntoView({ block: "center" });
  }, [ready]);
  return at;
}

function Loading() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
const Problem = ({ children }: { children: React.ReactNode }) => (
  <p className="p-4 text-sm text-destructive">{children}</p>
);

const chunkClass = (on: boolean) =>
  cn(
    "scroll-mt-4 rounded-md px-2 py-2 font-serif text-[15px] leading-relaxed whitespace-pre-wrap",
    on ? "bg-brass/10 ring-1 ring-brass/40" : "text-muted-foreground",
  );

export function LawSource({ chunkId }: { chunkId: number }) {
  const trpc = useTRPC();
  const view = useQuery(trpc.corpus.chunk.queryOptions({ chunkId }));
  const key = view.data?.chunk.docKey;
  const doc = useQuery(trpc.corpus.doc.queryOptions({ key: key ?? "" }, { enabled: !!key }));
  const at = useScrollTo(doc.isSuccess);
  if (view.isPending) return <Loading />;
  if (view.isError) return <Problem>Could not load it: {view.error.message}</Problem>;
  if (!view.data) return <Problem>This provision is no longer in the corpus.</Problem>;
  const { chunk: c, doc: info, changes, later, date } = view.data;
  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1">
        <h3 className="font-serif text-lg leading-snug font-semibold">{info?.title ?? c.docKey}</h3>
        <p className="text-xs text-muted-foreground">{c.path ?? c.label}</p>
      </div>
      {changes.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Changed by, up to {date}
          </h4>
          <ul className="space-y-2">
            {changes.map((ch, i) => (
              <li key={i} className="rounded-md border bg-card p-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{ch.byTitle ?? ch.by}</span>
                  {ch.byLabel && <span className="text-muted-foreground">s. {ch.byLabel}</span>}
                  <Badge variant="outline" className="ml-auto">
                    {ch.kind}
                  </Badge>
                </div>
                {ch.date && <p className="text-xs text-muted-foreground">{ch.date}</p>}
                <p className="mt-1 text-xs text-muted-foreground">
                  {ch.clause.slice(0, 240)}
                  {ch.clause.length > 240 ? "…" : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {later.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Later: {later.map((l) => `${l.by} ${l.kind} (${l.date})`).join("; ")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/doc/${c.docKey}#c${c.chunkId}`} target="_blank" rel="noopener">
            Full page <ExternalLink />
          </a>
        </Button>
        {info?.sourceUrl && (
          <Button asChild variant="ghost" size="sm">
            <a href={info.sourceUrl} target="_blank" rel="noreferrer">
              Source file <ExternalLink />
            </a>
          </Button>
        )}
      </div>
      <div className="border-t pt-3">
        {doc.isPending && <Skeleton className="h-64 w-full" />}
        {doc.isError && <Problem>Could not load the law: {doc.error.message}</Problem>}
        {doc.data?.chunks.map((x) => (
          <section key={x.id} ref={x.id === c.chunkId ? at : undefined} className={chunkClass(x.id === c.chunkId)}>
            {x.path && <p className="mb-1 font-sans text-xs text-muted-foreground">{x.path}</p>}
            {x.text}
          </section>
        ))}
      </div>
    </div>
  );
}

/** A case file, whole, page by page; n the cited chunk (null: the file itself was cited). */
export function FileSource({ caseId, fileId, n }: { caseId?: string; fileId: string; n: number | null }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.case.fileChunks.queryOptions({ caseId: caseId ?? "", fileId }, { enabled: !!caseId }));
  const at = useScrollTo(q.isSuccess);
  if (!caseId) return <Problem>This file belongs to a case: open the chat in its case to see it.</Problem>;
  if (q.isPending) return <Loading />;
  if (q.isError) return <Problem>Could not load the file: {q.error.message}</Problem>;
  const f = q.data;
  const cited = f.chunks.find((c) => c.n === n);
  let page = 0;
  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1">
        <h3 className="font-serif text-lg leading-snug font-semibold">{f.title ?? f.name}</h3>
        <p className="text-xs text-muted-foreground">Case file{cited ? `, page ${cited.page}` : ""}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href={`/cases/${caseId}/files/${f.id}`} target="_blank" rel="noopener">
          Open file <ExternalLink />
        </a>
      </Button>
      <div className="border-t pt-3">
        {!f.chunks.length && <p className="text-sm text-muted-foreground">This file has no text.</p>}
        {f.chunks.map((c) => {
          const head = c.page !== page;
          page = c.page;
          return (
            <div key={c.n}>
              {head && <p className="mt-3 mb-1 text-xs font-medium text-muted-foreground">Page {c.page}</p>}
              <section ref={c.n === n ? at : undefined} className={chunkClass(c.n === n || n == null)}>
                {c.text}
              </section>
            </div>
          );
        })}
      </div>
    </div>
  );
}
