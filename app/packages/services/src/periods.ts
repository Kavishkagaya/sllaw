// Usage periods as [from, to). Months and days are Sri Lanka's (UTC+05:30 all year, no daylight saving): a month
// starts at its midnight there, so a day's usage never falls into the month beside it.
const COLOMBO = 5.5 * 3_600_000;

/** The start of the calendar month d falls in (Sri Lanka time) and of the next: the default usage period. */
export function monthOf(d = new Date()) {
  const local = new Date(d.getTime() + COLOMBO);
  const y = local.getUTCFullYear(),
    m = local.getUTCMonth();
  return { from: new Date(Date.UTC(y, m, 1) - COLOMBO), to: new Date(Date.UTC(y, m + 1, 1) - COLOMBO) };
}

export const PERIODS = ["month", "last-month", "7d", "30d", "90d"] as const;
export type PeriodName = (typeof PERIODS)[number];
export type Period = { from: Date; to: Date };

/** A named period: this or last calendar month, or the last n days up to now. */
export function periodOf(name: PeriodName = "month", now = new Date()): Period {
  if (name === "month") return monthOf(now);
  if (name === "last-month") return monthOf(new Date(monthOf(now).from.getTime() - 1));
  const days = Number(name.slice(0, -1));
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}

/** The period before p, as long: the month before a calendar month, else the same number of days before. */
export function previousOf(name: PeriodName, p: Period): Period {
  if (name === "month" || name === "last-month") return monthOf(new Date(p.from.getTime() - 1));
  return { from: new Date(p.from.getTime() - (p.to.getTime() - p.from.getTime())), to: p.from };
}

/** The Sri Lanka day d falls in, as [from, to): what daily limits count and when they reset. */
export function dayOf(d = new Date()) {
  const local = new Date(d.getTime() + COLOMBO);
  const from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - COLOMBO;
  return { from: new Date(from), to: new Date(from + 86_400_000) };
}
