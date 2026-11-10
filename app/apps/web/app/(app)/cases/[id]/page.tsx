import { ChevronRight, MessageSquarePlus, Pencil, Upload } from "lucide-react";
import Link from "next/link";
import { StartChat } from "@/components/chat/start-chat";
import { CaseDashboard } from "@/components/office/dashboard";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /cases/<id>: the case's office. Its dashboard (docs/APP.md, Case office: details, next date, tasks, journal,
// people and the widgets the lawyer or the AI added), a question box that starts a case chat, the facts, its latest
// chats and what its files are.
export default async function CaseOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const [c, office, chats, files] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.office.open({ caseId: id })),
    orNotFound(api.chat.list({ caseId: id, limit: 5 })),
    orNotFound(api.case.files({ caseId: id })),
  ]);
  const groups = [...Map.groupBy(files, (f) => f.group)].map(([group, items]) => ({ group, n: items.length }));
  const base = `/cases/${c.id}`;
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: c.title }]}>
        <Button asChild size="sm" variant="ghost">
          <Link href={`${base}/settings`}>
            <Pencil /> Edit
          </Link>
        </Button>
      </PageHeader>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto pb-36">
          <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-6">
            <CaseDashboard caseId={c.id} title={c.title} initial={office} />

            <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-8">
              <div className="min-w-0 space-y-10">
                <section>
                  <div className="flex items-baseline justify-between gap-2 border-b border-foreground/15 pb-1.5">
                    <h2 className="font-serif text-[1.05rem] font-semibold tracking-tight">Facts</h2>
                    <Link href={`${base}/settings`} className="text-xs text-muted-foreground hover:text-foreground">
                      Edit
                    </Link>
                  </div>
                  {c.facts ? (
                    <p className="mt-3 max-w-prose font-serif text-[0.95rem] leading-relaxed whitespace-pre-wrap text-foreground/80 line-clamp-8">
                      {c.facts}
                    </p>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">
                      No facts yet. The AI reads every question in this case against them.{" "}
                      <Link href={`${base}/settings`} className="text-primary underline underline-offset-2">
                        Write the facts
                      </Link>
                    </p>
                  )}
                </section>
              </div>

              <div className="min-w-0 space-y-8">
                <section>
                  <div className="flex items-center justify-between gap-2 border-b border-foreground/15 pb-1">
                    <h2 className="font-serif text-[1.05rem] font-semibold tracking-tight">Chats</h2>
                    <Button asChild size="icon-sm" variant="ghost" aria-label="New chat">
                      <Link href={`${base}/chats`}>
                        <MessageSquarePlus />
                      </Link>
                    </Button>
                  </div>
                  {chats.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">No chats yet. Ask a question to start one.</p>
                  ) : (
                    <ul>
                      {chats.map((ch) => (
                        <li key={ch.id} className="border-b border-border/70">
                          <Link
                            href={`${base}/chats/${ch.id}`}
                            className="group flex items-baseline gap-3 py-2 text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate group-hover:underline">{ch.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(ch.updatedAt)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <div className="flex items-center justify-between gap-2 border-b border-foreground/15 pb-1">
                    <h2 className="flex items-baseline gap-2 font-serif text-[1.05rem] font-semibold tracking-tight">
                      Files
                      {files.length > 0 && (
                        <span className="font-sans text-xs font-normal text-muted-foreground">{files.length}</span>
                      )}
                    </h2>
                    <Button
                      asChild
                      size="icon-sm"
                      variant="ghost"
                      aria-label={files.length ? "Open files" : "Add files"}
                    >
                      <Link href={`${base}/files`}>{files.length ? <ChevronRight /> : <Upload />}</Link>
                    </Button>
                  </div>
                  {files.length === 0 ? (
                    <Link
                      href={`${base}/files`}
                      className="block py-2 text-sm text-muted-foreground hover:text-foreground"
                    >
                      Add plaints, affidavits, judgments: each is read and sorted by kind.
                    </Link>
                  ) : (
                    <ul>
                      {groups.map((g) => (
                        <li key={g.group} className="border-b border-border/70">
                          <Link href={`${base}/files`} className="group flex items-baseline gap-3 py-2 text-sm">
                            <span className="min-w-0 flex-1 truncate group-hover:underline">{g.group}</span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{g.n}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </div>
        </main>
        {/* the question box floats over the page's foot: asking about the case is the first thing a lawyer does here */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-background from-55% to-transparent px-4 pt-10 pb-4 sm:px-6">
          <div className="pointer-events-auto mx-auto max-w-3xl">
            <StartChat caseId={c.id} placeholder="Ask about this case…" />
          </div>
        </div>
      </div>
    </div>
  );
}
