// A regulation's name as a lawyer cites it: "Title, Gazette No. 2345/03 (14.08.2023)" (chat-regulations d2). The
// listing's title is "Department - subject" ("Imports and Exports Control Department - The Imports and Exports
// (Control) Regulations No. 12 of 2023 ..."): the department goes, the subject is cut to a citable length.

export const isGazette = (key: string) => key.startsWith("gazette:");

const MAX = 100;

/** "Ministry of X - The Y Regulations No. 2 of 2021 " -> "The Y Regulations No. 2 of 2021" */
export function gazetteSubject(title: string | null | undefined) {
  const t = title?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const at = t.indexOf(" - ");
  const s = at > 0 && t.length - at - 3 >= 20 ? t.slice(at + 3).trim() : t;
  return s.length <= MAX ? s : `${s.slice(0, MAX).replace(/\s+\S*$/, "")}…`;
}

/** 2023-08-14 -> 14.08.2023 */
const day = (d: string | null | undefined) =>
  d
    ?.match(/^(\d{4})-(\d{2})-(\d{2})/)
    ?.slice(1)
    .reverse()
    .join(".") ?? null;

/** The gazette's display name: subject, Gazette No. (date). */
export function gazetteTitle(g: { key: string; title?: string | null; date?: string | null }) {
  const no = g.key.replace(/^gazette:/, "");
  const d = day(g.date);
  return [gazetteSubject(g.title), `Gazette No. ${no}${d ? ` (${d})` : ""}`].filter(Boolean).join(", ");
}
