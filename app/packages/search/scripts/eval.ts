// Recall of searchLaw over etl/eval_questions.json, the same questions and hit rule as etl/eval_search.py, so the
// two must agree (PIPELINE.md, "Search recall": dense en 93% @5). Hits only; no Neon read.
//   pnpm --filter @sllaw/search eval
import { readFileSync } from "node:fs";
import { type Hit, type Mode, searchLaw } from "../src";

type Q = { id: number; doc: string; label: string; en: string; si: string; ta: string };
const qs: Q[] = JSON.parse(readFileSync(new URL("../../../../etl/eval_questions.json", import.meta.url), "utf8"));
const langs = ["en", "si", "ta"] as const;
const modes: Mode[] = ["dense", "weighted"];

// the gold chunk's law title, read from its own hit (search filtered to the gold law)
const titleOf = async (q: Q) =>
  (await searchLaw(q.en, { filters: { docKeys: [q.doc] }, limit: 1 }))[0]?.title.trim().toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ranks: Record<string, (number | null)[]> = {};
for (const q of qs) {
  const title = await titleOf(q);
  const sec = new RegExp(`\\bsection ${esc(q.label)}(?: |$)`);
  for (const l of langs)
    for (const m of modes) {
      const hits: Hit[] = await searchLaw(q[l], { mode: m, limit: 10 });
      const i = hits.findIndex((h) => h.title.trim().toLowerCase() === title && sec.test(h.path));
      (ranks[`${m} ${l}`] ??= []).push(i < 0 ? null : i + 1);
    }
}
console.log(`${qs.length} questions\nmode     lang    @1    @5   @10`);
for (const [k, rs] of Object.entries(ranks)) {
  const at = (n: number) => `${Math.round((100 * rs.filter((r) => r && r <= n).length) / rs.length)}%`.padStart(6);
  console.log(k.padEnd(15) + at(1) + at(5) + at(10));
}
