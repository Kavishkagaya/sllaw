// The full text of every chunk a tool returned in this request, by real id: the mapper fills it before it cuts a hit to
// a snippet for the model, so a read of that chunk later in the turn needs no database or R2 call. Not saved: only
// the id map is (map.ts).
import type { Kind, Real } from "./map";

export type Cached = Record<string, any> & { text: string };

export class ChunkCache {
  private m = new Map<string, Cached>();
  put(kind: Kind, real: Real, c: Cached) {
    this.m.set(`${kind}|${real}`, c);
  }
  get(kind: Kind, real: Real): Cached | undefined {
    return this.m.get(`${kind}|${real}`);
  }
}
