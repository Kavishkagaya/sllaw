// Dates, sizes and doc types as the UI shows them. Fixed locale and time zone, so the server and the browser render
// the same text (no hydration mismatch).
const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Colombo",
});

export const fmtDate = (d: Date | string) => date.format(new Date(d));

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A doc type as a label: "written_submissions" -> "Written submissions". */
export const docTypeLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).replaceAll("_", " ");

/** USD with enough digits to see a cent fraction: $12.40, $0.0123, $0. */
export function fmtUsd(n: number) {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3).replace(/0+$/, "")}`;
}

/** A count, short: 950, 12.3K, 4.1M. By hand, not Intl's compact notation: Node writes "4.1m" where browsers write
 *  "4.1M", and a server-rendered number then fails hydration. */
export function fmtNum(n: number) {
  const a = Math.abs(n);
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const v = Math.round((n / d) * 10) / 10;
  // 999,950 rounds to 1000K: step up a unit
  if (s && Math.abs(v) >= 1000) return fmtNum(Math.sign(n) * 1000 * d);
  return `${s ? v : Math.round(n)}${s}`;
}
