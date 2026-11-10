// What the dates say: the next court date, the dates still waiting for an outcome, the journal, and today in Colombo
// (the courts' day, whatever the server's clock).
import type { CourtDate, Office, Task } from "./schema";

/** Today as YYYY-MM-DD in Sri Lanka. */
export const today = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" });

/** YYYY-MM-DD plus n days. */
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const byDate = (a: CourtDate, b: CourtDate) => a.date.localeCompare(b.date);

/** The earliest court date not yet past (today counts), or null. */
export const nextDate = (o: Office, day: string): CourtDate | null =>
  o.dates.filter((d) => d.date >= day).sort(byDate)[0] ?? null;

/** Past dates with no outcome recorded, oldest first: each asks "What happened on <date>?". */
export const awaitingOutcome = (o: Office, day: string): CourtDate[] =>
  o.dates.filter((d) => d.date < day && d.outcome == null).sort(byDate);

/** Every date, newest first. */
export const journal = (o: Office): CourtDate[] => [...o.dates].sort((a, b) => byDate(b, a));

/** Open tasks by due date (no date last), then done ones. */
export function sortedTasks(o: Office) {
  const due = (t: Task) => t.due ?? "9999-12-31";
  const open = o.tasks.filter((t) => !t.done).sort((a, b) => due(a).localeCompare(due(b)));
  return { open, done: o.tasks.filter((t) => t.done) };
}

export const overdue = (t: Task, day: string) => !t.done && t.due != null && t.due < day;
