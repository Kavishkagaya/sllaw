// The mapper between the model and the tools: a tool keeps its real ids; wrapTools gives the model a copy whose id
// fields take handles (s3, c7, f2), turns them into real ids before the tool runs and the real ids in its output into
// handles after. toModel / toReal do the same to stored message parts (the database keeps real ids; the model's
// history is rebuilt in handles each turn), and to citations in text.
import { type Tool, tool } from "ai";
import { z } from "zod";
import { ChunkCache } from "./cache";
import type { Kind, Real, SourceMap } from "./map";
import { type Crop, type Field, SPECS, type Spec } from "./specs";

type Obj = Record<string, any>;
type Visit = (holder: Obj, key: string | number, up: Obj[]) => void;

/** Calls fn on every value at path in v: the holder (object or array), its key, and the objects above it, the
 *  nearest last (the root first). */
function walk(v: unknown, segs: string[], fn: Visit, up: Obj[] = []) {
  if (v == null || typeof v !== "object" || !segs.length) return;
  const [seg, ...rest] = segs as [string, ...string[]];
  const many = seg.endsWith("[]");
  const name = many ? seg.slice(0, -2) : seg;
  const o = v as Obj;
  const here = Array.isArray(o) ? up : [...up, o];
  if (!many) {
    if (!rest.length) {
      if (o[name] != null) fn(o, name, here);
    } else walk(o[name], rest, fn, here);
    return;
  }
  const list = name ? o[name] : o;
  if (!Array.isArray(list)) return;
  if (!rest.length) {
    for (let i = 0; i < list.length; i++) if (list[i] != null) fn(list, i, here);
  } else for (const item of list) walk(item, rest, fn, here);
}

const each = (
  v: unknown,
  fields: Field[] | undefined,
  fn: (f: Field, holder: Obj, key: string | number, up: Obj[]) => void,
) => {
  for (const f of fields ?? []) walk(v, f.path.split("."), (h, k, up) => fn(f, h, k, up));
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REAL: Record<Kind, RegExp> = { s: /^\d+$/, c: new RegExp(`^${UUID}:\\d+$`), f: new RegExp(`^${UUID}$`) };
const isReal = (kind: Kind, x: unknown): x is Real =>
  kind === "s" ? typeof x === "number" : typeof x === "string" && REAL[kind].test(x);

/** Real ids -> handles (minting), in a copy; a new handle's label comes from the objects around the id. */
export function idsToModel(v: unknown, fields: Field[] | undefined, map: SourceMap) {
  if (v == null || typeof v !== "object") return v;
  const out = structuredClone(v);
  each(out, fields, (f, h, k, up) => {
    if (isReal(f.kind, h[k])) h[k] = map.handle(f.kind, h[k], f.label?.(up) ?? null);
  });
  return out;
}

/** Handles -> real ids, in a copy. A value that is not a handle of the chat is left as it is (an old chat's real id),
 *  or reported to `bad` (a model's call). */
export function idsToReal(v: unknown, fields: Field[] | undefined, map: SourceMap, bad?: string[]) {
  if (v == null || typeof v !== "object") return v;
  const out = structuredClone(v);
  each(out, fields, (f, h, k) => {
    const e = typeof h[k] === "string" ? map.get(h[k], f.kind) : null;
    if (e) h[k] = e.real;
    else if (bad) bad.push(String(h[k]));
  });
  return out;
}

/** Every chunk a tool returned with its full text, into the cache by real id; the file and title above it go with
 *  it (a file chunk inside its file). */
function fill(result: unknown, fields: Field[] | undefined, cache: ChunkCache) {
  each(
    result,
    fields?.filter((f) => f.cache),
    (f, h, k, up) => {
      const own = up.at(-1);
      if (!own || typeof own.text !== "string" || !isReal(f.kind, h[k])) return;
      const near = (key: string) => [...up].reverse().find((o) => o[key] != null)?.[key];
      cache.put(f.kind, h[k], { file: near("file"), title: near("title"), ...own, text: own.text });
    },
  );
}

/** Each text at a crop's path cut to its max chars and renamed (text -> snippet), in a copy. */
function crop(result: unknown, crops: Crop[] | undefined) {
  if (!crops?.length || result == null || typeof result !== "object") return result;
  const out = structuredClone(result);
  for (const c of crops)
    walk(out, c.path.split("."), (h, k) => {
      const t = h[k];
      if (typeof t !== "string") return;
      delete h[k];
      h[c.as] = t.length > c.max ? `${t.slice(0, c.max)}…` : t;
    });
  return out;
}

// ---- tools ----

const idSchema = (kind: Kind, description?: string) =>
  z.string().describe(description ?? `a source id from a tool result, e.g. ${kind}3`);

/** The model's input schema: each id field a handle string instead of its real type (top-level fields only). */
function modelSchema(schema: z.ZodObject, fields: Field[] | undefined) {
  const shape: Record<string, z.ZodType> = { ...schema.shape };
  for (const f of fields ?? []) {
    const [top, ...rest] = f.path.split(".");
    if (rest.length) throw new Error(`id field ${f.path}: only top-level input fields are mapped`);
    const many = top!.endsWith("[]");
    const name = many ? top!.slice(0, -2) : top!;
    const orig = shape[name];
    if (!orig) throw new Error(`id field ${name} is not in the input schema`);
    const optional = orig.safeParse(undefined).success;
    let s: z.ZodType = idSchema(f.kind, orig.description);
    if (many) s = z.array(s);
    shape[name] = optional ? s.optional() : s;
  }
  return z.object(shape);
}

/** The model's copy of the tools: same names, descriptions and results, with handles for ids. The tools' own input
 *  schemas still check the input once mapped back. Typed as the tools: what the client and the database see is the
 *  real form. */
export function wrapTools<T extends Record<string, Tool>>(
  tools: T,
  map: SourceMap,
  cache = new ChunkCache(),
  specs: Record<string, Spec> = SPECS,
): T {
  const out: Record<string, Tool> = {};
  const memo = new Map<string, unknown>();
  for (const [name, t] of Object.entries(tools)) {
    const spec = specs[name];
    if (!spec) {
      out[name] = t;
      continue;
    }
    const schema = t.inputSchema as unknown as z.ZodObject;
    out[name] = tool({
      description: t.description,
      inputSchema: modelSchema(schema, spec.in),
      execute: async (input: unknown, opts: Parameters<NonNullable<Tool["execute"]>>[1]) => {
        const bad: string[] = [];
        const real = idsToReal(input, spec.in, map, bad);
        if (bad.length)
          return `No source ${bad.join(", ")} in this chat: use an id as a tool result gave it (s3, c7, f2).`;
        const ok = schema.safeParse(real);
        if (!ok.success)
          return `Bad input: ${ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        const key = spec.memo ? `${name}|${JSON.stringify(ok.data)}` : null;
        let result = key ? memo.get(key) : undefined;
        result ??= spec.cached?.(ok.data, cache);
        if (result === undefined) {
          result = await t.execute!(ok.data, opts);
          fill(result, spec.out, cache); // the full text, before crop cuts it
        }
        if (key) memo.set(key, result);
        return idsToModel(crop(result, spec.crop), spec.out, map);
      },
    } as never);
  }
  return out as T;
}

// ---- citations in text ----

const clean = (s: string | null) =>
  (s ?? "source")
    .replace(/[\]|[]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "source";
// the model's: [[s3]], [[c7]], [[f2]], also several in one ([[s3, s4]]) and with a label it should not have written
const MODEL_CITE = /\[\[\s*([scf]\d+(?:\s*[,;]\s*[scf]\d+)*)\s*(?:\|[^\]]*)?\]\]/g;
// the client's (and the database's): [[81234|label]] law, [[f:<fileId>:<n>|label]] a file chunk, [[file:<fileId>|label]]
const REAL_CITE = /\[\[(?:(\d+)|f:([0-9a-f-]{36}:\d+)|file:([0-9a-f-]{36}))(?:\|([^\]|]*))?\]\]/g;

/** [[s3]] -> [[81234|s. 22, Rent Act]]; a handle the chat does not have is dropped (never shown as a source). */
export const citesToReal = (text: string, map: SourceMap) =>
  text.replace(MODEL_CITE, (_, list: string) =>
    list
      .split(/[,;]/)
      .map((h) => {
        const e = map.get(h);
        if (!e) return "";
        const label = clean(e.label);
        return e.kind === "s"
          ? `[[${e.real}|${label}]]`
          : e.kind === "c"
            ? `[[f:${e.real}|${label}]]`
            : `[[file:${e.real}|${label}]]`;
      })
      .join(""),
  );

/** [[81234|label]] -> [[s3]] (minting for an old chat's citations, which had no map). */
export const citesToModel = (text: string, map: SourceMap) =>
  text.replace(REAL_CITE, (_, law?: string, chunk?: string, file?: string, label?: string) => {
    const l = label?.trim() || null;
    return `[[${law ? map.handle("s", +law, l) : chunk ? map.handle("c", chunk, l) : map.handle("f", file!, l)}]]`;
  });

// ---- message parts ----

type Part = { type: string; text?: string; input?: unknown; output?: unknown; [k: string]: unknown };
const toolOf = (p: Part) => (p.type.startsWith("tool-") ? SPECS[p.type.slice(5)] : undefined);

/** A stored message's parts (real ids) as the model sees them (handles). */
export function partsToModel<P extends Part>(parts: P[], map: SourceMap): P[] {
  return parts.map((p) => {
    if (p.type === "text" && p.text) return { ...p, text: citesToModel(p.text, map) };
    const spec = toolOf(p);
    if (!spec) return p;
    return {
      ...p,
      ...(p.input !== undefined && { input: idsToModel(p.input, spec.in, map) }),
      ...(p.output !== undefined && { output: idsToModel(p.output, spec.out, map) }),
    };
  });
}

/** The model's parts (handles) in their real form, for the client and the database. */
export function partsToReal<P extends Part>(parts: P[], map: SourceMap): P[] {
  return parts.map((p) => {
    if (p.type === "text" && p.text) return { ...p, text: citesToReal(p.text, map) };
    const spec = toolOf(p);
    if (!spec) return p;
    return {
      ...p,
      ...(p.input !== undefined && { input: idsToReal(p.input, spec.in, map) }),
      ...(p.output !== undefined && { output: idsToReal(p.output, spec.out, map) }),
    };
  });
}
