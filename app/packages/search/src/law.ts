// Law search: the Zilliz collection `chunks` (etl/embed.py writes it; id = chunk id). `dense` (default) for
// questions in plain words; `weighted` adds a small BM25 weight for exact strings (PIPELINE.md, "Search recall");
// `keyword` is BM25 alone, to find given words: "section 51", "No. 20 of 2009", a phrase from a link's text.
// Hits come from Zilliz alone, so a search reads no chunk text out of Neon.
import { embed } from "./embed";
import { zilliz } from "./zilliz";

export type Mode = "dense" | "weighted" | "keyword";
export type Filters = { docKeys?: string[]; kinds?: string[]; yearFrom?: number; yearTo?: number };
export type Hit = { chunkId: number; docKey: string; title: string; path: string; label: string | null; text: string; score: number };

const K = 30; // candidates per leg of a weighted search, as in etl/eval_search.py
const KEY = /^[a-z0-9:/._-]{1,64}$/; // act:9/2023, cap1956:331, constitution:21

/** Filters come from an agent's tool call: values are checked before they go into the expression. */
export function filterExpr(f: Filters = {}) {
  const list = (xs: string[]) => {
    if (!xs.every((x) => KEY.test(x))) throw new Error(`bad filter value: ${xs}`);
    return JSON.stringify(xs);
  };
  const parts: string[] = [];
  if (f.docKeys?.length) parts.push(`doc_key in ${list(f.docKeys)}`);
  if (f.kinds?.length) parts.push(`kind in ${list(f.kinds)}`);
  if (f.yearFrom != null) parts.push(`year >= ${Math.trunc(f.yearFrom)}`);
  if (f.yearTo != null) parts.push(`year <= ${Math.trunc(f.yearTo)}`);
  return parts.join(" and ");
}

/** The query must be English: the corpus is, and the agent translates Sinhala/Tamil first (docs/APP.md). */
export async function searchLaw(query: string, opts: { mode?: Mode; filters?: Filters; limit?: number } = {}) {
  const { limit = 10 } = opts;
  // BM25's English analyzer reads no Sinhala or Tamil script, so those queries go dense
  const mode = /[\u0D80-\u0DFF\u0B80-\u0BFF]/.test(query) ? "dense" : (opts.mode ?? "dense");
  const expr = filterExpr(opts.filters);
  const filter = expr ? { filter: expr } : {};
  const common = { collectionName: "chunks", limit, outputFields: ["doc_key", "label", "text"] };
  const sparse = { data: [query], annsField: "sparse" };
  const rows: any[] =
    mode === "keyword"
      ? await zilliz("entities/search", { ...common, ...sparse, ...filter })
      : mode === "weighted"
        ? await zilliz("entities/hybrid_search", {
            ...common,
            search: [
              { data: await embed([query]), annsField: "vec", limit: K, ...filter },
              { ...sparse, limit: K, ...filter },
            ],
            rerank: { strategy: "weighted", params: { weights: [0.7, 0.3] } },
          })
        : await zilliz("entities/search", { ...common, data: await embed([query]), annsField: "vec", ...filter });
  return rows.map((r): Hit => {
    // text = "law title › breadcrumb\n\nchunk" (etl/embed.py)
    const [head, ...body] = r.text.split("\n\n");
    const [title, ...path] = head.split(" › ");
    return { chunkId: Number(r.id), docKey: r.doc_key, title, path: path.join(" › "), label: r.label ?? null, text: body.join("\n\n"), score: r.distance };
  });
}
