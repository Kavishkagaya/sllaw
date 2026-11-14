import { currentUser } from "@clerk/nextjs/server";
import { nextDate } from "@sllaw/office";
import { FileText, MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { StartChat } from "@/components/chat/start-chat";
import { HomeDiary } from "@/components/office/home-diary";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { fmtShort, label, leaf } from "@/lib/office";
import { serverApi } from "@/trpc/server";

// The dashboard (neethi-redesign d5; Home before, now at /dashboard): a greeting with a question box first, this
// week's dates and tasks across the cases, then the cases as docket cards (court, next date, facts, files, chats).
export default async function Dashboard() {
  const api = await serverApi();
  const [cases, diary, user] = await Promise.all([api.case.list(), api.office.diary(), currentUser()]);
  // the docket cards' court and next date: the offices of the cases shown
  const shown = cases.slice(0, 6);
  const [offices, chats] = await Promise.all([
    Promise.all(shown.map((c) => api.office.open({ caseId: c.id }).catch(() => null))),
    Promise.all(shown.map((c) => api.chat.list({ caseId: c.id }).catch(() => []))),
  ]);
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Colombo" }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const d = leaf(diary.today);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b bg-card px-3">
        <SidebarTrigger />
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-10 px-4 pt-8 pb-16 sm:px-8 sm:pt-10">
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex-[1_1_360px]">
              <div className="label-mono text-[11px] text-primary">
                {d.weekday} · {d.day} {d.month}
              </div>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] sm:text-[38px]">
                {greeting}
                {user?.firstName ? `, ${user.firstName}` : ""}.
              </h1>
            </div>
            <div className="flex-[1_1_380px]">
              <StartChat placeholder="A quick question on the law…" />
            </div>
          </div>

          {cases.length > 0 && <HomeDiary diary={diary} />}

          <section aria-labelledby="cases">
            <div className="mb-3.5 flex items-baseline gap-3">
              <h2 id="cases" className="text-[15px] font-semibold">
                Cases
              </h2>
              <span className="flex-1" />
              {cases.length > 0 && (
                <Link href="/cases" className="text-[13px] text-primary hover:underline">
                  All cases
                </Link>
              )}
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2">
              {shown.map((c, i) => {
                const o = offices[i]?.office;
                const next = o && offices[i] ? nextDate(o, offices[i].today) : null;
                const line = [o?.header.court, o?.header.caseNumber, o?.header.side && label(o.header.side)]
                  .filter(Boolean)
                  .join(" · ");
                const n = chats[i]?.length ?? 0;
                return (
                  <Link
                    key={c.id}
                    href={`/cases/${c.id}`}
                    className="flex overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow hover:shadow-md"
                  >
                    <span className={`w-1.5 shrink-0 ${next ? "bg-primary" : "bg-muted-foreground/50"}`} />
                    <span className="flex min-w-0 flex-1 flex-col gap-2 px-4.5 py-4">
                      {line && <span className="label-mono truncate text-[10px] text-muted-foreground">{line}</span>}
                      <span className="text-[17px] leading-snug font-semibold tracking-[-0.015em]">{c.title}</span>
                      {c.facts && (
                        <span className="line-clamp-2 text-[13px] leading-normal text-muted-foreground">{c.facts}</span>
                      )}
                      <span className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
                        {next && (
                          <span className="text-law-ink">
                            ● {fmtShort(next.date)}
                            {next.purpose ? ` · ${label(next.purpose)}` : ""}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <FileText className="size-3" /> {c.files} {c.files === 1 ? "file" : "files"}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageSquare className="size-3" /> {n} {n === 1 ? "chat" : "chats"}
                        </span>
                      </span>
                    </span>
                  </Link>
                );
              })}
              <Link
                href="/cases/new"
                className="flex min-h-36 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              >
                <Plus className="size-4" /> New case
              </Link>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
