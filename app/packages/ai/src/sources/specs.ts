// Which fields of each tool's input and output hold a real id, and of what kind: the mapper (wrap.ts) turns them into
// handles for the model and back. The tools themselves only ever see and return real ids, and every field of an output
// that holds one must be here, or it reaches the model. A path is a field name, a dotted path into objects, `x[]` for
// every item of the array x, `[]` for every item of an array output. `label` is a new handle's label, from the objects
// above the id (`up`: the root first, the one holding the field last).
// `cache`: the object holding the id has the chunk's full text (`text`): it goes into the request's chunk cache
// (cache.ts) before `crop` cuts it for the model. `cached`: the answer from the cache alone, when it has every chunk
// asked for (undefined: run the tool). `memo`: the same input again in this request gets the same answer, unrun.
import type { Cached, ChunkCache } from "./cache";
import type { Kind } from "./map";

type Obj = Record<string, any>;
export type Field = { path: string; kind: Kind; label?: (up: Obj[]) => string | null; cache?: true };
export type Crop = { path: string; max: number; as: string }; // path to a text field; cut to max chars, renamed `as`
export type Spec = {
  in?: Field[];
  out?: Field[];
  crop?: Crop[];
  cached?: (input: any, cache: ChunkCache) => unknown | undefined;
  memo?: true;
};

// "Part II › section 22 — Notice to quit. (cont.)" -> "s. 22"; Articles -> "Art. 12"
function where(path: string | null | undefined, label: string | null | undefined) {
  const last = path?.split("›").at(-1)?.split(" — ")[0]?.replace("(cont.)", "").trim();
  const w = last || (label ? `section ${label}` : "");
  return w.replace(/^section\s+/i, "s. ").replace(/^article\s+/i, "Art. ") || null;
}
// the corpus has many titles in capitals (the Revised Editions): "MUNICIPAL COUNCILS" -> "Municipal Councils",
// "RENT (AMENDMENT) ACT, No. 26 OF 2002" -> "Rent (Amendment) Act, No. 26 of 2002"
const SMALL = new Set(["of", "the", "and", "for", "to", "in", "on", "by", "or", "a", "an"]);
function titled(t: string | null | undefined) {
  if (!t) return null;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (!letters || letters.replace(/[^A-Z]/g, "").length / letters.length < 0.8) return t;
  return t
    .toLowerCase()
    .replace(/[a-z]+/g, (w, at: number) => (at > 0 && SMALL.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)));
}
const join = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(", ") || null;

const own = (up: Obj[]) => up.at(-1) ?? {};
// act:7/1972 -> "Act No. 7 of 1972": many corpus titles are a bare short title ("Rent"), which names no law alone
function lawNo(key: string | undefined) {
  const m = key?.match(/^(act|law):(\d+)\/(\d{4})$/);
  if (m) return `${m[1] === "act" ? "Act" : "Law"} No. ${m[2]} of ${m[3]}`;
  const c = key?.match(/^cap(1956)?:(\d+)$/);
  if (c) return `Cap. ${c[2]}${c[1] ? ", 1956 ed." : ""}`;
  return null;
}
/** A law's name: its title, with its number when the title has none. */
export function lawName(title: string | null | undefined, key: string | undefined) {
  const t = titled(title);
  if (!t) return lawNo(key) ?? key ?? null;
  const no = /\bno\.|\bcap\.|constitution|amendment/i.test(t) ? null : lawNo(key);
  return no ? `${t} (${no})` : t;
}
/** A law chunk's label from the chunk itself (search hit, read, asOf): "s. 22, Rent (Act No. 7 of 1972)". */
export const lawLabel = (o: Obj) => join(where(o.path, o.label), lawName(o.title, o.docKey));
const law = (up: Obj[]) => lawLabel(own(up));
const amending = (up: Obj[]) => {
  const o = own(up);
  return join(o.byLabel ? `s. ${o.byLabel}` : null, lawName(o.byTitle, o.by));
};
const fileTitle = (up: Obj[]) => own(up).title ?? null;
// a file chunk: its file's title (on the chunk, or the file above it) and page
const page = (up: Obj[]) =>
  join([...up].reverse().find((o) => o.title)?.title, own(up).page != null ? `p. ${own(up).page}` : null);

const SNIPPET = 300; // chars of a search hit the model sees; it reads the ones it wants in full (keeps context small)

/** fileRead of passages by id, from the cache when every one is there (fileSearch put them), grouped by file. */
function fileReadCached({ chunks }: { chunks?: string[] }, cache: ChunkCache) {
  if (!chunks?.length) return undefined;
  const got = chunks.map((id) => cache.get("c", id));
  if (got.some((c) => !c)) return undefined;
  type Group = { file: string; title: string; chunks: Record<string, unknown>[] };
  const files = new Map<string, Group>();
  for (const c of got as Cached[]) {
    const g: Group = files.get(c.file) ?? { file: c.file, title: c.title, chunks: [] };
    g.chunks.push({ chunk: c.chunk, page: c.page, text: c.text });
    files.set(c.file, g);
  }
  return { files: [...files.values()] };
}

export const SPECS: Record<string, Spec> = {
  search: {
    out: [{ path: "[].chunkId", kind: "s", label: law, cache: true }],
    crop: [{ path: "[].text", max: SNIPPET, as: "snippet" }],
  },
  // a law read is a whole section (several chunks from the database), so a search hit alone cannot answer it
  read: {
    in: [{ path: "chunkIds[]", kind: "s" }],
    out: [
      { path: "[].chunkId", kind: "s", label: law },
      { path: "[].more", kind: "s" }, // the section's next chunk: labelled when read
    ],
    memo: true,
  },
  links: {
    in: [{ path: "chunkId", kind: "s" }],
    out: [{ path: "[].chunkIds[]", kind: "s" }],
  },
  asOf: {
    in: [{ path: "chunkId", kind: "s" }],
    out: [
      { path: "chunk.chunkId", kind: "s", label: law },
      { path: "changes[].byChunk", kind: "s", label: amending },
    ],
  },
  fileSearch: {
    in: [{ path: "files[]", kind: "f" }],
    out: [
      { path: "hits[].chunk", kind: "c", label: page, cache: true },
      { path: "hits[].file", kind: "f", label: fileTitle },
    ],
    crop: [{ path: "hits[].text", max: SNIPPET, as: "snippet" }],
  },
  fileCard: {
    in: [{ path: "files[]", kind: "f" }],
    out: [
      { path: "files[].file", kind: "f", label: fileTitle },
      { path: "cards[].file", kind: "f", label: fileTitle },
    ],
  },
  fileRead: {
    in: [
      { path: "file", kind: "f" },
      { path: "chunks[]", kind: "c" },
    ],
    out: [
      { path: "files[].file", kind: "f", label: fileTitle },
      { path: "files[].chunks[].chunk", kind: "c", label: page, cache: true },
      { path: "files[].rest[]", kind: "c" }, // labelled when read
    ],
    cached: fileReadCached,
  },
};
