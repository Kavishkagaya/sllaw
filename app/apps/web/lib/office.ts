// Dates and labels of the case office as the UI shows them, for server and client components alike.
export const label = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replaceAll("_", " ") : s);

const day = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
/** "2026-12-12" -> "Sat, 12 Dec 2026" (the date as written: no time zone shift). */
export const fmtDay = (d: string) => day.format(new Date(`${d}T00:00:00Z`));

/** Days from today to d: 0 today, 1 tomorrow, -2 two days ago. */
export const daysFrom = (today: string, d: string) =>
  Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

export function whenLabel(today: string, d: string) {
  const n = daysFrom(today, d);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n > 1) return `In ${n} days`;
  if (n === -1) return "Yesterday";
  return `${-n} days ago`;
}

const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "2026-11-28" -> "28 Nov". */
export const fmtShort = (d: string) => short.format(new Date(`${d}T00:00:00Z`));

const parts = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(x);
  return {
    day: f({ day: "numeric" }),
    month: f({ month: "short" }),
    weekday: f({ weekday: "long" }),
    year: f({ year: "numeric" }),
  };
};
/** A date as a diary leaf shows it: day, month, weekday, year. */
export const leaf = parts;

/** Where a widget sits on the dashboard: the cover band (details and the next date), the main column (the record),
 *  or the rail (tasks, people, checklists). */
export type Zone = "cover" | "main" | "rail";
export function zoneOf(type: string): Zone {
  if (type === "header" || type === "next_date") return "cover";
  if (type === "tasks" || type === "people" || type === "checklist") return "rail";
  return "main";
}

/** Markdown images from our own origin only: a remote image would send its URL (which text planted in a case file
 *  could fill with case facts) to another server on every view (security review, 2026-11-11). */
export const ownImage = (src: unknown) =>
  typeof src === "string" && ((src.startsWith("/") && !src.startsWith("//")) || src.startsWith("data:image/"));
