// A judgment's name as a lawyer cites an unreported one: "Keerthi v. Gamage, CA/WRT/634/2021 (12.12.2025)". The
// court's listing gives the parties as its caption has them, addresses and roles included ("1. K.A. Gunawathi, Darshana
// Stores, Serukade ... Defendants-Respondents Vs. ..."): each side is cut to its first party's name.

export const isJudgment = (key: string) => /^(ca|sc):/.test(key);

export const COURT = { ca: "Court of Appeal", sc: "Supreme Court" } as const;

// "Vs.", "Vs", "-Vs-" in any case; else a lower-case " v. " (an upper-case "V." is an initial: "A. V. Perera")
const VS = /\s*-?\bvs\b\.?\s*-?\s*/i;
const V = /\s+v\.?\s+/;
// where a party's name ends: an address, a role, the next numbered party, a second name after ";"
const END =
  /\s*(?:[,;]|\bNo[.:]?\s*\d|\s\d{1,3}[A-Z]?\.\s|\s\d+\/|\band (?:\d+|several) others\b|\b(?:plaintiffs?|defendants?|petitioners?|respondents?|appellants?|complainants?|accused|claimants?)\b).*$/i;

function party(side: string) {
  const name = side
    .replace(/\s+/g, " ")
    .replace(/^(?:\s*\d{1,3}[A-Z]?\.\s*)+/, "") // "1. ", "1. 2. "
    .replace(END, "")
    .replace(/[\s.,:;–-]+$/, "")
    .trim();
  if (name.length <= 60) return name;
  return `${name.slice(0, 60).replace(/\s+\S*$/, "")}…`;
}

/** "1. K.A. Gunawathi, Darshana Stores ... Vs. Hon. Attorney General" -> "K.A. Gunawathi v. Hon. Attorney General". */
export function shortParties(parties: string | null | undefined) {
  if (!parties?.trim()) return null;
  const [a, ...rest] = parties.split(VS.test(parties) ? VS : V);
  const first = party(a ?? "");
  const second = rest.length ? party(rest.join(" v. ")) : "";
  return [first, second].filter(Boolean).join(" v. ") || null;
}

/** 2025-12-12 -> 12.12.2025 */
const day = (d: string | null | undefined) =>
  d
    ?.match(/^(\d{4})-(\d{2})-(\d{2})/)
    ?.slice(1)
    .reverse()
    .join(".") ?? null;

/** The judgment's display name from its listing (docs.meta): parties, case number (date). */
export function judgmentTitle(j: { case?: string | null; date?: string | null; parties?: string | null }) {
  const p = shortParties(j.parties);
  const d = day(j.date);
  const c = j.case?.replace(/\s+/g, " ").trim() || null;
  const head = [p, c].filter(Boolean).join(", ");
  return head ? `${head}${d ? ` (${d})` : ""}` : null;
}
