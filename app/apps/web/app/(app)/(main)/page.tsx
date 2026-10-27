import { Briefcase, FileText, Plus } from "lucide-react";
import Link from "next/link";
import { StartChat } from "@/components/chat/start-chat";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { fmtDate } from "@/lib/format";
import { serverApi } from "@/trpc/server";

// Home: case first. The cases last worked on, a new one, and a box for a quick question outside any case.
export default async function Home() {
  const cases = await (await serverApi()).case.list();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center px-3">
        <SidebarTrigger />
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 pt-6 pb-12 sm:px-6 sm:pt-12">
          <section>
            <div className="flex items-end justify-between gap-4">
              <div>
                <h1 className="font-serif text-3xl font-semibold tracking-tight">Your cases</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Work inside a case: its chats read every question with its facts.
                </p>
              </div>
              {cases.length > 0 && (
                <Link href="/cases" className="shrink-0 text-sm text-primary underline-offset-2 hover:underline">
                  All cases
                </Link>
              )}
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Link
                href="/cases/new"
                className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <Plus className="size-5" /> New case
              </Link>
              {cases.slice(0, 5).map((c) => (
                <Link
                  key={c.id}
                  href={`/cases/${c.id}`}
                  className="flex min-h-28 flex-col gap-1 rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
                >
                  <span className="flex items-start gap-2">
                    <Briefcase className="mt-1 size-4 shrink-0 text-muted-foreground" />
                    <span className="line-clamp-2 font-serif text-base leading-snug font-semibold">{c.title}</span>
                  </span>
                  <span className="mt-auto flex justify-between gap-2 pt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="size-3.5" />
                      {c.files} {c.files === 1 ? "file" : "files"}
                    </span>
                    <span>{fmtDate(c.lastActivity)}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>

          <section className="mt-14">
            <h2 className="font-serif text-xl font-semibold tracking-tight">Quick question</h2>
            <p className="mt-1 mb-4 text-sm text-muted-foreground">
              Outside any case, answered from the Constitution and Acts of Sri Lanka. You can move it into a case later.
            </p>
            <StartChat />
          </section>
        </div>
      </main>
    </div>
  );
}
