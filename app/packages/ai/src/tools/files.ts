// The main agent's tools on the case's files (a case chat only). The instructions only say how many files there are;
// the agent finds what it needs: fileSearch finds passages (vector search over the file chunks), fileCard says what a
// file is (its categorizer card), fileRead returns chunks in full, by id or a file's pages. The tools work in real ids
// (a file's id, a chunk's `<fileId>:<n>`); the model sees handles (sources/). A file the case does not have is answered
// in words, never an error, so the model can correct itself. Chunks never cross a page, so every quote has one page.
import { tool } from "ai";
import { z } from "zod";
import { DOC_TYPES } from "../agents/categorize";
import type { CaseFile, Ctx, FileChunk } from "../ports";

export const READ_PAGES = 8; // pages per fileRead at most
export const READ_CHARS = 24_000; // and chars: the chunks that fit, at least one
export const READ_CHUNKS = 20; // chunks by id per fileRead
export const CARDS = 10; // full cards per fileCard call
export const LISTED = 100; // files in fileCard's list (no files, no types)

const fileId = z.string().describe("a case file's id, from fileSearch or fileCard");
const chunkId = (fileId: string, n: number) => `${fileId}:${n}`;

export const fileName = (f: CaseFile) => f.title ?? f.name;
const kind = (f: CaseFile) => (f.docType ? f.docType.replace(/_/g, " ") : null);
const STATE: Record<CaseFile["state"], string | null> = {
  ready: null,
  processing: "still being read",
  unreadable: "no readable text",
};

/** "4" or "3-6" -> [from, to]; null when it is neither. */
export function pageRange(s: string): [number, number] | null {
  const m = s.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!m) return null;
  const from = +m[1]!;
  const to = m[2] ? +m[2] : from;
  return from >= 1 && to >= from ? [from, to] : null;
}

export const fileTools = ({ ports, caseFiles }: Ctx) => {
  const byId = new Map(caseFiles.map((f) => [f.id, f]));
  const noFile = `No such case file. fileCard with no input lists the case's files.`;
  const notReady = (f: CaseFile) =>
    f.state === "processing"
      ? `${fileName(f)} is still being read. Say so; do not guess its contents.`
      : `${fileName(f)} has no readable text (a scan not yet read by OCR, or a format not read). Say so; do not guess its contents.`;
  // one line per file: what fileCard lists, and the head of a card
  const line = (f: CaseFile) => ({
    file: f.id,
    title: fileName(f),
    type: kind(f),
    pages: f.pages,
    ...(STATE[f.state] && { state: STATE[f.state] }),
  });
  const chunksOf = async (f: CaseFile) => (f.state === "ready" ? await ports.fileChunks(f.id) : null);
  const totalPages = (cs: FileChunk[]) => cs.at(-1)?.page ?? 0;

  return {
    fileSearch: tool({
      description:
        "Search the text of this case's files (the lawyer's documents: pleadings, affidavits, judgments, contracts, " +
        "letters). Plain words, as the file would put them; a Sinhala or Tamil file is best searched in its own " +
        "language. mode 'weighted' adds exact words (a name, a case number, a clause number). Narrow with files " +
        "or types. Returns each passage's id, file, page and first lines: read the passages you need with fileRead.",
      inputSchema: z.object({
        query: z.string(),
        files: z.array(fileId).optional().describe("only these files"),
        types: z.array(z.enum(DOC_TYPES)).optional().describe("only files of these kinds"),
        mode: z.enum(["dense", "weighted"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, files, types, mode, limit }) => {
        if (!caseFiles.length) return "The case has no files yet.";
        if (files?.some((id) => !byId.has(id))) return noFile;
        let pick = caseFiles.filter(
          (f) => (!files || files.includes(f.id)) && (!types || types.includes(f.docType as never)),
        );
        if (!pick.length) return `No case file of type ${types?.join(", ")}.`;
        const skipped = pick.filter((f) => !f.searchable);
        pick = pick.filter((f) => f.searchable);
        const note = skipped.length
          ? `Not searchable yet: ${skipped
              .map((f) => `${fileName(f)} (${f.state === "ready" ? "read its pages with fileRead" : STATE[f.state]})`)
              .join("; ")}.`
          : undefined;
        if (!pick.length) return note ?? "No case file can be searched.";
        const narrowed = files || types;
        const hits = await ports.fileSearch(query, {
          fileIds: narrowed ? pick.map((f) => f.id) : undefined,
          mode,
          limit,
        });
        const out = hits.flatMap((h) => {
          const f = byId.get(h.fileId);
          if (!f) return []; // removed from the case meanwhile
          // the full text: the mapper caches it, then cuts it to a snippet for the model
          return [
            { chunk: chunkId(f.id, h.n), file: f.id, title: fileName(f), type: kind(f), page: h.page, text: h.text },
          ];
        });
        return note ? { hits: out, note } : { hits: out };
      },
    }),
    fileCard: tool({
      description:
        "What a case file is: its type, language, pages, parties, dates, court, case numbers, the laws it cites, tags " +
        `and a summary. By file (up to ${CARDS}), or every file of some types; with neither, a one-line list of all ` +
        "the case's files. Use it to know whose document a passage is before you rely on it, or to see what the " +
        "case holds. A card describes a file and is not citable: cite passages you read with fileRead.",
      inputSchema: z.object({
        files: z.array(fileId).max(CARDS).optional(),
        types: z.array(z.enum(DOC_TYPES)).optional().describe("every file of these kinds"),
      }),
      execute: async ({ files, types }) => {
        if (!caseFiles.length) return "The case has no files yet.";
        if (!files?.length && !types?.length) {
          const list = caseFiles.slice(0, LISTED).map(line);
          const more = caseFiles.length - list.length;
          return more > 0
            ? { files: list, more: `${more} more: find them with fileSearch or by types` }
            : { files: list };
        }
        if (files?.some((id) => !byId.has(id))) return noFile;
        const pick = caseFiles.filter(
          (f) => files?.includes(f.id) || (types?.length && types.includes(f.docType as never)),
        );
        if (!pick.length) return `No case file of type ${types?.join(", ")}.`;
        const cards = await Promise.all(
          pick.slice(0, CARDS).map(async (f) => ({
            ...line(f),
            name: f.name,
            language: f.language,
            parties: f.parties,
            dates: f.dates,
            court: f.court,
            caseNumbers: f.caseNumbers,
            lawsCited: f.lawsCited,
            tags: f.tags,
            summary: await ports.fileSummary(f.id),
          })),
        );
        const more = pick.length - cards.length;
        return more > 0 ? { cards, more: `${more} more: ask for them by file` } : { cards };
      },
    }),
    fileRead: tool({
      description:
        `Read case-file text in full: passages by id (chunks, from fileSearch; up to ${READ_CHUNKS}), or a file's ` +
        `pages (file, and pages '4' or '3-6'; left out, from page 1; up to ${READ_PAGES} pages a call, and when the ` +
        "file goes on, 'more' is the next page to read; a page cut short lists its other passages in 'rest'). Every " +
        "passage comes back with its id: cite that.",
      inputSchema: z.object({
        chunks: z.array(z.string()).max(READ_CHUNKS).optional().describe("passage ids, from fileSearch"),
        file: fileId.optional(),
        pages: z.string().optional().describe("with file: a page or a range, '4' or '3-6'"),
      }),
      execute: async ({ chunks, file, pages }) => {
        if (chunks?.length) {
          const want = new Map<string, number[]>();
          for (const c of chunks) {
            const [id, n] = [c.slice(0, c.lastIndexOf(":")), +c.slice(c.lastIndexOf(":") + 1)];
            if (!byId.has(id)) return noFile;
            want.set(id, [...(want.get(id) ?? []), n]);
          }
          const files = [];
          for (const [id, ns] of want) {
            const f = byId.get(id)!;
            const all = await chunksOf(f);
            if (!all?.length) return notReady(f.state === "ready" ? { ...f, state: "unreadable" } : f);
            files.push({
              file: f.id,
              title: fileName(f),
              totalPages: totalPages(all),
              chunks: all
                .filter((c) => ns.includes(c.n))
                .map((c) => ({ chunk: chunkId(f.id, c.n), page: c.page, text: c.text })),
            });
          }
          return { files };
        }
        if (!file) return "Give chunks (passage ids) or a file with its pages.";
        const f = byId.get(file);
        if (!f) return noFile;
        if (f.state !== "ready") return notReady(f);
        const all = await chunksOf(f);
        if (!all?.length) return notReady({ ...f, state: "unreadable" });
        const range: [number, number | null] | null = pages ? pageRange(pages) : [1, null];
        if (!range) return `pages must be a page or a range, e.g. '4' or '3-6', not '${pages}'.`;
        const last = totalPages(all);
        const [from, to] = range;
        if (from > last) return `${fileName(f)} has ${last} page${last === 1 ? "" : "s"}; there is no page ${from}.`;
        const want = all.filter((c) => c.page >= from && c.page <= (to ?? last));
        const got: FileChunk[] = [];
        let chars = 0;
        for (const c of want) {
          const newPage = got.length > 0 && c.page !== got.at(-1)!.page;
          if (newPage && new Set(got.map((g) => g.page)).size >= READ_PAGES) break;
          if (got.length && chars + c.text.length > READ_CHARS) break; // a long page can stop part way
          got.push(c);
          chars += c.text.length;
        }
        const stop = want[got.length];
        const next = stop?.page;
        // stopped inside a page: its other passages by id, since reading the page again starts at its top
        const rest =
          stop && stop.page === got.at(-1)?.page
            ? want.slice(got.length, got.length + READ_CHUNKS).filter((c) => c.page === stop.page)
            : [];
        return {
          files: [
            {
              file: f.id,
              title: fileName(f),
              totalPages: last,
              chunks: got.map((c) => ({ chunk: chunkId(f.id, c.n), page: c.page, text: c.text })),
              ...(next != null && { more: next }),
              ...(rest.length > 0 && { rest: rest.map((c) => chunkId(f.id, c.n)) }),
            },
          ],
        };
      },
    }),
  };
};
