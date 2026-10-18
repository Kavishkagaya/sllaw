// What agents get from outside: `ctx`, the one thing passed to an agent and its tools. Its ports are functions
// services fills (search, read, links, as_of live in services; importing them here would be a cycle), already
// scoped to the request, so a tool can only reach what this user may see.
export type Mode = "dense" | "weighted" | "keyword";
export type Filters = { docKeys?: string[]; kinds?: string[]; yearFrom?: number; yearTo?: number };

export type Chunk = { chunkId: number; docKey: string; title: string | null; label: string | null; path: string | null; text: string };
export type Hit = Chunk & { score: number };
export type Link = {
  kind: string;
  srcDoc: string;
  srcChunk: number | null;
  dstDoc: string;
  dstLabel: string | null;
  dstChunk: number | null;
  date: string | null;
  context: string | null;
};
export type Direction = "out" | "in";
/** A chunk as enacted plus the changes to it, split at ctx.asOfDate (text as of a date is not built yet). */
export type AsOf = { chunk: Chunk; date: string; inForce: Link[]; later: Link[]; undated: Link[] };

export interface Ports {
  search(query: string, opts: { mode?: Mode; filters?: Filters; limit?: number }): Promise<Hit[]>;
  read(chunkIds: number[]): Promise<Chunk[]>;
  links(target: { docKey: string; chunkId?: number | null }, direction: Direction, opts?: { kinds?: string[]; text?: string }): Promise<Link[]>;
  asOf(chunkId: number): Promise<AsOf | null>;
}

export type Ctx = {
  workspaceId: string;
  userId: string;
  caseId: string | null; // a case chat; null in plain chat
  asOfDate: string; // YYYY-MM-DD: the law as it stood on this date, set by the lawyer (default today)
  scopes: string[]; // user:<id>, case:<id>: what user-file search may reach (#19)
  ports: Ports;
};
