// How a law and a place in it are named, as plain text: shared by server pages and client components.

/** A law's key as people cite it: act:9/2023 → "Act No. 9 of 2023", cap:107 → "Chapter 107". */
export function lawName(key: string) {
  const [kind, rest = ""] = key.split(":");
  const [n, year] = rest.split("/");
  if (kind === "act" && year) return `Act No. ${n} of ${year}`;
  if (kind === "law" && year) return `Law No. ${n} of ${year}`;
  if (kind === "ord" && year) return `Ordinance No. ${n} of ${year}`;
  if (kind === "cap" || kind === "cap1956") return `Chapter ${rest}${kind === "cap1956" ? " (1956 ed.)" : ""}`;
  if (kind === "constitution") return "Constitution of Sri Lanka";
  if (kind === "ca") return "Court of Appeal judgment";
  if (kind === "sc") return "Supreme Court judgment";
  if (kind === "gazette") return `Gazette Extraordinary No. ${rest}`;
  return key;
}

/** A Court of Appeal or Supreme Court judgment's key (ca:…, sc:…). */
export const isJudgment = (key: string) => /^(ca|sc):/.test(key);

/** A judgment's text as read: the PDF's lines come as paragraphs, so a break before a line that starts in lower case
 *  is the same sentence going on ("the notice of termination\n\nstipulated under the Rent Act"). */
export const prose = (t: string) => t.replace(/\s*\n\n(?=[a-z])/g, " ");

/** The last step of a chunk's breadcrumb ("Part II › section 13 — Notice (cont.)" → "section 13 — Notice"). */
export const pinpoint = (path: string | null, label: string | null) =>
  (path
    ?.split("›")
    .pop()
    ?.replace(/\s*\(cont\.\)\s*$/, "")
    .trim() ||
    label) ??
  null;

/** pinpoint, short, for lists: "section 22 — Proceedings for ejectment." → "s. 22 — Proceedings for ejectment". */
export const shortPin = (path: string | null, label: string | null) =>
  pinpoint(path, label)
    ?.replace(/^section\s+/i, "s. ")
    .replace(/^regulation\s+(?=\S+$)/i, "para ") // a gazette's paragraph, as its chip names it
    .replace(/\.$/, "") ?? null;

/** "RENT (AMENDMENT) ACT, No. 55 OF 1980" -> "Rent (Amendment) Act, No. 55 of 1980": some titles are stored in capitals. */
export const titleCase = (t: string) =>
  (t.match(/[a-z]/g)?.length ?? 0) * 4 > (t.match(/[A-Z]/g)?.length ?? 0)
    ? t
    : t
        .toLowerCase()
        .replace(/(^|[\s(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())
        .replace(/ (Of|And|The) /g, (w) => w.toLowerCase());

/** What the stored text of a law is (the corpus keeps the text as published, not as amended): "as enacted in 1972" for
 *  an Act, Law or Ordinance, the 1980 Revised Edition for a chapter, and so on. */
export function textAs(key: string) {
  const [kind, rest = ""] = key.split(":");
  const year = rest.split("/")[1];
  if (kind === "constitution" || key.startsWith("constitution:")) return "as enacted in 1978";
  if ((kind === "act" || kind === "law" || kind === "ord") && year) return `as enacted in ${year}`;
  if (kind === "cap") return "as in the 1980 Revised Edition";
  if (kind === "cap1956") return "as in the 1956 edition";
  return "as published";
}
