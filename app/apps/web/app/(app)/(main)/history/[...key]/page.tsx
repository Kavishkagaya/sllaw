import Link from "next/link";
import { notFound } from "next/navigation";
import { AmendmentLine } from "@/components/chat/source-view";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { lawName, pinpoint, textAs, titleCase } from "@/lib/law";
import { orNotFound, serverApi } from "@/trpc/server";

// /history/act:7/1972?c=<chunk id>: a section's full history (from the source panel's "Full history"): the section as
// enacted (the stored text; the corpus does not build the amended text), then every change made to it since with the
// amending section's whole text, then the whole law's timeline. The panel keeps the short timeline (user, 2026-11-15).
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string[] }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  const chunkId = Number((await searchParams).c);
  if (!Number.isInteger(chunkId) || chunkId <= 0) notFound();
  const h = await orNotFound((await serverApi()).corpus.history({ chunkId }));
  if (!h || h.chunk.docKey !== key) notFound();
  const where = pinpoint(h.chunk.path, h.chunk.label) ?? "This section";
  const section = where.split(" — ")[0];
  const title = h.doc?.title ?? h.chunk.title ?? key;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="truncate text-sm font-medium">History · {title}</span>
      </header>
      <main className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl space-y-8 px-6 py-10">
          <div>
            <p className="label-mono text-[10.5px] text-muted-foreground">{lawName(key)}</p>
            <h1 className="mt-1 text-3xl leading-tight font-semibold">{title}</h1>
            <p className="mt-1 text-muted-foreground">{where}</p>
            <Link href={`/doc/${key}#c${chunkId}`} className="mt-3 inline-block text-sm text-primary hover:underline">
              Open the law at this section
            </Link>
          </div>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold first-letter:uppercase">
              {section} {textAs(key)}
            </h2>
            <div className="rounded-md border bg-law px-4 py-3 font-law text-[14.5px] leading-relaxed whitespace-pre-wrap">
              {h.chunk.text}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">
              How {section} changed since
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {h.changes.length
                  ? `${h.changes.length} ${h.changes.length === 1 ? "change" : "changes"} up to ${h.date}`
                  : `never changed, up to ${h.date}`}
              </span>
            </h2>
            <ol className="space-y-6">
              {h.changes.map((c, i) => (
                <li key={i} className="space-y-2 border-l-2 border-primary pl-4">
                  <p className="text-sm">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{c.date ?? "undated"}</span>
                    <span className="mx-2 text-muted-foreground">·</span>
                    <span className="font-medium">{titleCase(c.byTitle ?? lawName(c.by))}</span>
                    {c.byLabel && <span className="text-muted-foreground">, s. {c.byLabel}</span>}
                  </p>
                  <p className="text-xs text-primary first-letter:uppercase">{c.kind} this section</p>
                  <div className="rounded-md border bg-card px-4 py-3 font-law text-[14.5px] leading-relaxed whitespace-pre-wrap">
                    {c.text}
                  </div>
                  {c.byChunk != null && (
                    <Link href={`/doc/${c.by}#c${c.byChunk}`} className="text-xs text-primary hover:underline">
                      Open {titleCase(c.byTitle ?? lawName(c.by))}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
            {h.later.length > 0 && (
              <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Changes after {h.date}: </span>
                {h.later.map((l) => `${l.by} ${l.kind} (${l.date})`).join("; ")}
              </p>
            )}
          </section>

          <Separator />

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">The whole law's timeline</h2>
            <AmendmentLine docKey={key} law={h.timeline} section={h.changes} />
          </section>
        </article>
      </main>
    </div>
  );
}
