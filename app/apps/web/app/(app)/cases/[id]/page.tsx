import { ChevronRight, FileText, MessageSquare, MessageSquarePlus, Pencil, Upload } from "lucide-react";
import Link from "next/link";
import { StartChat } from "@/components/chat/start-chat";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /cases/<id>: the case's overview. Its facts, a question box that starts a case chat, its latest chats and what
// its files are. Later the case dashboard (tasks, dates) grows here.
export default async function CaseOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const [c, chats, files] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
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
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{c.title}</h1>
          {c.facts ? (
            <p className="mt-3 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground line-clamp-6">
              {c.facts}
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No facts yet: the AI answers this case's questions from them.{" "}
              <Link href={`${base}/settings`} className="text-primary underline underline-offset-2">
                Add them
              </Link>
            </p>
          )}

          <div className="mt-8">
            <StartChat caseId={c.id} placeholder="Ask about this case…" />
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <section className="rounded-xl border bg-card shadow-xs">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-medium">Chats</h2>
                <Button asChild size="sm" variant="ghost">
                  <Link href={`${base}/chats`}>
                    <MessageSquarePlus /> New chat
                  </Link>
                </Button>
              </div>
              {chats.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No chats yet. Ask a question above.
                </p>
              ) : (
                <ul className="divide-y">
                  {chats.map((ch) => (
                    <li key={ch.id}>
                      <Link
                        href={`${base}/chats/${ch.id}`}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent/40"
                      >
                        <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{ch.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(ch.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border bg-card shadow-xs">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-medium">
                  Files{files.length > 0 && <span className="ml-1.5 text-muted-foreground">{files.length}</span>}
                </h2>
                <Button asChild size="sm" variant="ghost">
                  <Link href={`${base}/files`}>
                    {files.length ? "Open" : <Upload />} {files.length ? <ChevronRight /> : "Add files"}
                  </Link>
                </Button>
              </div>
              {files.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Plaints, affidavits, judgments: each is read and sorted by kind.
                </p>
              ) : (
                <ul className="divide-y">
                  {groups.map((g) => (
                    <li key={g.group}>
                      <Link
                        href={`${base}/files`}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent/40"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{g.group}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{g.n}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
