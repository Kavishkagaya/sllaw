// What agents get from outside: `ctx`, the one thing passed to an agent and its tools. Its ports are functions
// services fills (search, read, links, as_of live in services; importing them here would be a cycle), already
// scoped to the request, so a tool can only reach what this user may see.
export type Mode = "dense" | "weighted" | "keyword";
export type Filters = { docKeys?: string[]; kinds?: string[]; yearFrom?: number; yearTo?: number };

export type Chunk = {
  chunkId: number;
  docKey: string;
  title: string | null;
  label: string | null;
  path: string | null;
  text: string;
};
/** A chunk as read: `more` is the next chunk's id when its section goes on past what read returned. */
export type ReadChunk = Chunk & { more?: number };
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
/** One change to a section: the amending law and section, and that section's text (the operative clause, cut). */
export type Change = {
  date: string | null;
  kind: string;
  by: string;
  byTitle: string | null;
  byLabel: string | null;
  byChunk: number | null;
  clause: string;
};
/** A section as enacted and the changes made to it up to ctx.asOfDate (undated ones included), oldest first; later
 *  changes only named. The text as amended is not built: the agent reads it from the clauses. */
export type AsOf = {
  chunk: Chunk;
  date: string;
  changes: Change[];
  later: { date: string; kind: string; by: string }[];
};
/** How much a section was changed, for a search hit: amending sections, last change, date of a repeal. */
export type Status = { changes: number; last: string | null; repealed: string | null };

export interface Ports {
  search(query: string, opts: { mode?: Mode; filters?: Filters; limit?: number }): Promise<Hit[]>;
  read(chunkIds: number[]): Promise<ReadChunk[]>;
  links(
    target: { docKey: string; chunkId?: number | null },
    direction: Direction,
    opts?: { kinds?: string[]; text?: string },
  ): Promise<Link[]>;
  asOf(chunkId: number): Promise<AsOf | null>;
  status(chunkIds: number[]): Promise<Record<number, Status>>;
}

export type Ctx = {
  workspaceId: string;
  userId: string;
  caseId: string | null; // a case chat; null in plain chat
  asOfDate: string; // YYYY-MM-DD: the law as it stood on this date, set by the lawyer (default today)
  scopes: string[]; // user:<id>, case:<id>: what user-file search may reach (#19)
  ports: Ports;
};
