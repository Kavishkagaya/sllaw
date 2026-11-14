// Home's diary (docs/APP.md, Case office): the lawyer's week across their cases. Court dates today and in the next
// seven days as a diary ledger (past dates still waiting for what happened come first), and tasks due by then with
// overdue ones marked. Each row opens its case.
import type { AppRouter } from "@sllaw/api";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { daysFrom, fmtDay, fmtShort, label, leaf, whenLabel } from "@/lib/office";
import { cn } from "@/lib/utils";

type Diary = inferRouterOutputs<AppRouter>["office"]["diary"];

const caseName = (r: { title: string; caseNumber: string }) => r.caseNumber || r.title;

function DateRow({
  href,
  date,
  today,
  title,
  sub,
  waiting,
}: {
  href: string;
  date: string;
  today: string;
  title: string;
  sub: string;
  waiting?: boolean;
}) {
  const l = leaf(date);
  const isToday = date === today;
  return (
    <li className="border-t">
      <Link href={href} className="group grid grid-cols-[4rem_1fr] transition-colors hover:bg-accent/50">
        <div
          className={cn("border-r py-2.5 pr-3 text-right", isToday && "text-primary", waiting && "text-unverified-ink")}
        >
          <div className="text-xl leading-none font-semibold tabular-nums">{l.day}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{l.weekday.slice(0, 3)}</div>
        </div>
        <div className="min-w-0 py-2.5 pr-4 pl-3 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium group-hover:underline">{title}</span>
            <span
              className={cn(
                "ml-auto shrink-0 text-xs",
                waiting ? "text-unverified-ink" : isToday ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {waiting ? "Record what happened" : whenLabel(today, date)}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">{sub}</div>
        </div>
      </Link>
    </li>
  );
}

export function HomeDiary({ diary }: { diary: Diary }) {
  const { today, upcoming, waiting, tasks } = diary;
  const empty = !upcoming.length && !waiting.length && !tasks.length;
  const sub = (d: { purpose: string; court: string; title: string; caseNumber: string }) =>
    [d.purpose && label(d.purpose), d.court, d.caseNumber && d.title].filter(Boolean).join(", ");
  return (
    <section aria-labelledby="week">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="week" className="text-2xl font-semibold tracking-tight">
          This week
        </h2>
        <span className="text-sm text-muted-foreground">{fmtDay(today)}</span>
      </div>
      {empty ? (
        <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
          No court dates or tasks this week. Add them on a case's dashboard and they show here.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="overflow-hidden rounded-lg border bg-card shadow-2xs">
            <h3 className="px-4 pt-3 pb-2 text-[1.05rem] font-semibold">Court dates</h3>
            {!upcoming.length && !waiting.length ? (
              <p className="border-t px-4 py-3 text-sm text-muted-foreground">None in the next seven days.</p>
            ) : (
              <ol>
                {waiting.map((d) => (
                  <DateRow
                    key={`w${d.id}`}
                    href={`/cases/${d.caseId}`}
                    date={d.date}
                    today={today}
                    title={caseName(d)}
                    sub={sub(d)}
                    waiting
                  />
                ))}
                {upcoming.map((d) => (
                  <DateRow
                    key={d.id}
                    href={`/cases/${d.caseId}`}
                    date={d.date}
                    today={today}
                    title={caseName(d)}
                    sub={sub(d)}
                  />
                ))}
              </ol>
            )}
          </div>
          <div>
            <div className="flex items-baseline gap-2 border-b border-foreground/15 pb-1.5">
              <h3 className="text-[1.05rem] font-semibold">Tasks due</h3>
              {tasks.some((t) => t.due < today) && (
                <span className="text-xs text-destructive">{tasks.filter((t) => t.due < today).length} overdue</span>
              )}
            </div>
            {!tasks.length ? (
              <p className="py-2 text-sm text-muted-foreground">Nothing due this week.</p>
            ) : (
              <ul>
                {tasks.map((t) => (
                  <li key={t.id} className="border-b border-border/70">
                    <Link href={`/cases/${t.caseId}`} className="group flex items-baseline gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate group-hover:underline">{t.task}</span>
                        <span className="block truncate text-xs text-muted-foreground">{caseName(t)}</span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs tabular-nums",
                          t.due < today ? "font-medium text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {t.due < today ? `${-daysFrom(today, t.due)}d late` : fmtShort(t.due)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
