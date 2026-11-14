// The dashboard's week (docs/APP.md, Case office): the lawyer's court dates today and in the next seven days as date
// tiles (past dates still waiting for what happened come first, dashed in amber), and the tasks due by then with
// overdue ones marked. Each opens its case.
import type { AppRouter } from "@sllaw/api";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { daysFrom, fmtShort, label, leaf, whenLabel } from "@/lib/office";
import { cn } from "@/lib/utils";

type Diary = inferRouterOutputs<AppRouter>["office"]["diary"];

const caseName = (r: { title: string; caseNumber: string }) => r.caseNumber || r.title;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A date as a tear-off leaf: the month on an oxblood band (amber when it waits for an outcome), the day under it. */
function Leaf({ date, waiting }: { date: string; waiting?: boolean }) {
  const l = leaf(date);
  return (
    <span
      className={cn(
        "w-[46px] shrink-0 overflow-hidden rounded-md border text-center",
        waiting ? "border-unverified-border" : "border-law-border",
      )}
    >
      <span
        className={cn(
          "label-mono block py-0.5 text-[9px] text-white",
          waiting ? "bg-[#9a5b16]" : "bg-[#7d1d2c] dark:bg-[#8f2636]",
        )}
      >
        {l.month}
      </span>
      <span className="block py-0.5 text-[21px] leading-tight font-semibold tabular-nums">{l.day}</span>
    </span>
  );
}

export function HomeDiary({ diary }: { diary: Diary }) {
  const { today, upcoming, waiting, tasks } = diary;
  const dates = waiting.length + upcoming.length;
  const late = tasks.filter((t) => t.due < today).length;
  const sub = (d: { purpose: string; court: string }) =>
    [d.purpose && label(d.purpose), d.court].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby="week">
      <div className="mb-3.5 flex items-baseline gap-3">
        <h2 id="week" className="text-[15px] font-semibold">
          This week
        </h2>
        <span className="label-mono text-[10.5px] text-muted-foreground">
          {plural(dates, "date")} · {plural(tasks.length, "task")}
        </span>
      </div>
      {!dates && !tasks.length ? (
        <p className="rounded-xl border border-dashed bg-card/60 px-4 py-4 text-sm text-muted-foreground">
          No court dates or tasks this week. Add them on a case's page and they show here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {dates > 0 && (
            <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              {waiting.map((d) => (
                <li key={`w${d.id}`}>
                  <Link
                    href={`/cases/${d.caseId}`}
                    className="flex h-full gap-3.5 rounded-xl border border-dashed border-unverified-border bg-card px-4 py-3.5 hover:shadow-sm"
                  >
                    <Leaf date={d.date} waiting />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-semibold">What happened on {fmtShort(d.date)}?</span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                        {caseName(d)} · add the outcome
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
              {upcoming.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/cases/${d.caseId}`}
                    className="flex h-full gap-3.5 rounded-xl border bg-card px-4 py-3.5 hover:shadow-sm"
                  >
                    <Leaf date={d.date} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold">{caseName(d)}</span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{sub(d)}</span>
                      <span
                        className={cn(
                          "mt-0.5 block text-[12px]",
                          d.date === today ? "font-medium text-primary" : "text-muted-foreground",
                        )}
                      >
                        {whenLabel(today, d.date)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          {tasks.length > 0 && (
            <div className="rounded-xl border bg-card">
              <div className="flex items-baseline gap-2 border-b px-4 py-2.5">
                <h3 className="text-[13.5px] font-semibold">Tasks due</h3>
                {late > 0 && <span className="text-xs text-destructive">{late} overdue</span>}
              </div>
              <ul>
                {tasks.map((t) => (
                  <li key={t.id} className="border-b last:border-b-0">
                    <Link
                      href={`/cases/${t.caseId}`}
                      className="group flex min-h-11 items-center gap-3 px-4 py-2 text-sm"
                    >
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}
