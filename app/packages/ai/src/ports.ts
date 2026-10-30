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

/** A file of the case as the agent's file tools know it (not in its instructions: it finds files by search and
 *  asks for their cards). The tools name it by its id; the model sees it as a handle (sources/map.ts). */
export type CaseFile = {
  id: string;
  name: string; // the filename
  title: string | null; // the categorizer's title
  docType: string | null;
  language: string | null;
  pages: number | null;
  state: "ready" | "processing" | "unreadable"; // its text: read, still being read, or none (a scan without OCR)
  searchable: boolean; // indexed: fileSearch finds it
  // the categorizer's card, from the file row (its summary is read only when asked for: Ports.fileSummary)
  parties: { name: string; role: string }[];
  dates: { date: string; what: string }[];
  court: string | null;
  caseNumbers: string[];
  lawsCited: string[];
  tags: string[];
};
/** A passage of a case file from search: one chunk (n, from 0, its place in the file's chunks.json), never across a
 *  page. */
export type FilePassage = { fileId: string; n: number; page: number; text: string; score: number };
/** One of a file's chunks, as the index cut them (chunks.json): its id is `<fileId>:<n>`. */
export type FileChunk = { n: number; page: number; text: string };

export interface Ports {
  search(query: string, opts: { mode?: Mode; filters?: Filters; limit?: number }): Promise<Hit[]>;
  /** The case's files only (services scopes it to case:<id>); fileIds narrows further. */
  fileSearch(
    query: string,
    opts: { fileIds?: string[]; mode?: "dense" | "weighted"; limit?: number },
  ): Promise<FilePassage[]>;
  /** Every chunk of a case file, in order; null when it is not a file of this case or has no text. */
  fileChunks(fileId: string): Promise<FileChunk[] | null>;
  /** A case file's summary (its card's, in the blob store); null when there is none yet. */
  fileSummary(fileId: string): Promise<string | null>;
  read(chunkIds: number[]): Promise<ReadChunk[]>;
  links(
    target: { docKey: string; chunkId?: number | null },
    direction: Direction,
    opts?: { kinds?: string[]; text?: string },
  ): Promise<Link[]>;
  asOf(chunkId: number, date?: string): Promise<AsOf | null>; // date left out: ctx.asOfDate
  status(chunkIds: number[]): Promise<Record<number, Status>>;
  /** A decision model's yes/no answers on one state, as probabilities by question id (trace; tools/trace.ts). Set
   *  only when the trace experiment is on (TRACE=1): without it the trace tool is not offered. */
  decide?(state: string, questions: Record<string, string>): Promise<Record<string, number>>;
}

export type Ctx = {
  workspaceId: string;
  userId: string;
  caseId: string | null; // a case chat; null in plain chat
  caseBrief: { title: string; facts: string } | null; // that case's title and facts, always in the instructions
  caseFiles: CaseFile[]; // that case's files, oldest first, for the file tools (only counted in the instructions); []
  // in plain chat
  asOfDate: string; // YYYY-MM-DD: the law as it stood on this date, set by the lawyer (default today)
  scopes: string[]; // user:<id>, case:<id>: what user-file search may reach (#19)
  ports: Ports;
};
