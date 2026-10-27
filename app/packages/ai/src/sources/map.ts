// A chat's source ids (docs/APP.md, Sources): the model never sees a real id. Every id a tool returns is given a short
// handle the first time (s<n> a law chunk, c<n> a case file's chunk, f<n> a case file) and keeps it for the whole
// chat, so earlier turns' tool outputs and citations stay valid and the provider's prompt cache still matches.
// Saved on the chat (chats.sources) as handle -> [real id, label]; the label is what the UI shows with a citation's
// number. Real ids: a law chunk's etl chunk id (append-only in production), a file chunk's `<fileId>:<n>`, a file's id.
export type Kind = "s" | "c" | "f";
export type Real = number | string;
export type Entry = [real: Real, label: string | null];
export type SourcesJson = Record<string, Entry>;

export const HANDLE = /^([scf])(\d+)$/;

export class SourceMap {
  private entries = new Map<string, Entry>();
  private byReal = new Map<string, string>();
  private next: Record<Kind, number> = { s: 1, c: 1, f: 1 };
  changed = false;

  constructor(json?: SourcesJson | null) {
    for (const [h, e] of Object.entries(json ?? {})) {
      const m = h.match(HANDLE);
      if (!m || !Array.isArray(e)) continue;
      const kind = m[1] as Kind;
      this.entries.set(h, [e[0], e[1] ?? null]);
      this.byReal.set(key(kind, e[0]), h);
      this.next[kind] = Math.max(this.next[kind], +m[2]! + 1);
    }
  }

  /** The handle of a real id, minted when it has none. A label fills a missing one (a chunk first seen as a bare id,
   *  in a link, gets its label when a tool shows the chunk itself). */
  handle(kind: Kind, real: Real, label: string | null = null): string {
    const k = key(kind, real);
    let h = this.byReal.get(k);
    if (!h) {
      h = `${kind}${this.next[kind]++}`;
      this.entries.set(h, [real, label]);
      this.byReal.set(k, h);
      this.changed = true;
      return h;
    }
    const e = this.entries.get(h)!;
    if (label && !e[1]) {
      e[1] = label;
      this.changed = true;
    }
    return h;
  }

  /** A handle's entry, or null when the chat has none by that name (or it is of another kind). */
  get(handle: string, kind?: Kind): { kind: Kind; real: Real; label: string | null } | null {
    const m = handle.trim().match(HANDLE);
    if (!m || (kind && m[1] !== kind)) return null;
    const e = this.entries.get(`${m[1]}${+m[2]!}`);
    return e ? { kind: m[1] as Kind, real: e[0], label: e[1] } : null;
  }

  toJSON(): SourcesJson {
    return Object.fromEntries(this.entries);
  }
}

const key = (kind: Kind, real: Real) => `${kind}|${real}`;
