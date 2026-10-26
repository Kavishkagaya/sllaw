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
