// The case-file tools (real ids, full text), on fake ports: no model, store
// or index.
import { describe, expect, it } from "vitest";
import type { CaseFile, Ctx, FileChunk, FilePassage } from "../ports";
import { CARDS, fileTools, pageRange, READ_PAGES } from "./files";

const uuid = (c: string) => `${c.repeat(8)}-0000-4000-8000-000000000000`;
const file = (c: string, over: Partial<CaseFile> = {}): CaseFile => ({
  id: uuid(c),
  name: `${c}.pdf`,
  title: null,
  docType: null,
  language: "en",
  pages: null,
  state: "ready",
  searchable: true,
  parties: [],
  dates: [],
  court: null,
  caseNumbers: [],
  lawsCited: [],
  tags: [],
  ...over,
});

/** n pages, `per` chunks a page, each `chars` long. */
const chunks = (n: number, chars = 100, per = 1): FileChunk[] =>
  Array.from({ length: n * per }, (_, i) => ({
    n: i,
    page: Math.floor(i / per) + 1,
    text: `chunk ${i} `.padEnd(chars, "x"),
  }));

function setup(
  files: CaseFile[],
  text: Record<string, FileChunk[]>,
  hits: FilePassage[] = [],
  summaries: Record<string, string> = {},
) {
  const searched: { query: string; fileIds?: string[] }[] = [];
  const ctx = {
    caseFiles: files,
    ports: {
      fileSearch: async (query: string, o: { fileIds?: string[] }) => {
        searched.push({ query, fileIds: o.fileIds });
        return hits;
      },
      fileChunks: async (id: string) => text[id] ?? null,
      fileSummary: async (id: string) => summaries[id] ?? null,
    },
  } as unknown as Ctx;
  const t = fileTools(ctx);
  const call = { toolCallId: "t", messages: [], context: {} };
  return {
    searched,
    read: (input: Parameters<NonNullable<typeof t.fileRead.execute>>[0]) =>
      t.fileRead.execute!(input, call) as Promise<any>,
    search: (input: Parameters<NonNullable<typeof t.fileSearch.execute>>[0]) =>
      t.fileSearch.execute!(input, call) as Promise<any>,
    card: (input: Parameters<NonNullable<typeof t.fileCard.execute>>[0]) =>
      t.fileCard.execute!(input, call) as Promise<any>,
  };
}
const pagesOf = (r: any) => r.files[0].chunks.map((c: { page: number }) => c.page);

describe("pageRange", () => {
  it("reads a page or a range", () => {
    expect(pageRange("4")).toEqual([4, 4]);
    expect(pageRange("3-6")).toEqual([3, 6]);
    expect(pageRange(" 3 – 6 ")).toEqual([3, 6]);
    expect(pageRange("6-3")).toBeNull();
    expect(pageRange("0")).toBeNull();
    expect(pageRange("p4")).toBeNull();
  });
});

describe("fileRead", () => {
  const plaint = file("a", { title: "Plaint" });
  it("reads a file's pages as chunks with their ids, up to the page cap with 'more'", async () => {
    const { read } = setup([plaint], { [plaint.id]: chunks(20, 100, 2) });
    const one = await read({ file: plaint.id, pages: "4" });
    expect(one.files[0]).toMatchObject({ file: plaint.id, title: "Plaint", totalPages: 20 });
    expect(one.files[0].chunks.map((c: { chunk: string }) => c.chunk)).toEqual([`${plaint.id}:6`, `${plaint.id}:7`]);
    expect(one.files[0].more).toBeUndefined();
    expect(pagesOf(await read({ file: plaint.id, pages: "3-6" }))).toEqual([3, 3, 4, 4, 5, 5, 6, 6]);
    const start = await read({ file: plaint.id });
    expect(new Set(pagesOf(start)).size).toBe(READ_PAGES);
    expect(start.files[0].more).toBe(READ_PAGES + 1);
    expect(new Set(pagesOf(await read({ file: plaint.id, pages: "15-30" })))).toEqual(
      new Set([15, 16, 17, 18, 19, 20]),
    );
  });

  it("stops at the char cap, inside a long page too, listing that page's other passages", async () => {
    const { read } = setup([plaint], { [plaint.id]: chunks(5, 10_000) });
    const r = await read({ file: plaint.id });
    expect(pagesOf(r)).toEqual([1, 2]);
    expect(r.files[0].more).toBe(3);
    expect(r.files[0].rest).toBeUndefined();
    const big = setup([plaint], { [plaint.id]: chunks(1, 1500, 30) }); // one page of 45,000 chars
    const b = await big.read({ file: plaint.id });
    expect(b.files[0].chunks.length).toBe(16);
    expect(b.files[0].more).toBe(1);
    expect(b.files[0].rest[0]).toBe(`${plaint.id}:16`);
  });

  it("reads passages by id, grouped by file", async () => {
    const lease = file("b", { title: "Lease" });
    const { read } = setup([plaint, lease], { [plaint.id]: chunks(3), [lease.id]: chunks(2) });
    const r = await read({ chunks: [`${plaint.id}:2`, `${lease.id}:0`, `${plaint.id}:0`] });
    expect(r.files.map((f: any) => [f.title, f.chunks.map((c: any) => c.chunk)])).toEqual([
      ["Plaint", [`${plaint.id}:0`, `${plaint.id}:2`]],
      ["Lease", [`${lease.id}:0`]],
    ]);
  });

  it("answers in words: an unknown file, a page past the end, a bad range, a file not read", async () => {
    const scan = file("c", { state: "unreadable" });
    const busy = file("d", { state: "processing" });
    const { read } = setup([plaint, scan, busy], { [plaint.id]: chunks(3) });
    expect(await read({ file: uuid("e") })).toMatch(/No such case file\. fileCard with no input lists/);
    expect(await read({ chunks: [`${uuid("e")}:1`] })).toMatch(/No such case file/);
    expect(await read({ file: plaint.id, pages: "9" })).toMatch(/has 3 pages; there is no page 9/);
    expect(await read({ file: plaint.id, pages: "two" })).toMatch(/pages must be/);
    expect(await read({ file: scan.id })).toMatch(/no readable text/);
    expect(await read({ file: busy.id })).toMatch(/still being read/);
    expect(await read({})).toMatch(/Give chunks/);
  });
});

describe("fileSearch", () => {
  const a = file("a", { title: "Plaint", docType: "plaint" });
  const b = file("b", { docType: "affidavit" });
  const c = file("c", { docType: "affidavit", searchable: false });
  const hit = (f: CaseFile, n: number, page: number, text = "rent arrears") => ({
    fileId: f.id,
    n,
    page,
    text,
    score: 1,
  });

  it("returns each passage's id, file, page and full text; searches all the case's files unless narrowed", async () => {
    const s = setup([a, b], {}, [
      hit(a, 7, 4, "z".repeat(400)),
      { fileId: "gone", n: 0, page: 1, text: "x", score: 1 },
    ]);
    const r = await s.search({ query: "arrears" });
    expect(r.hits).toEqual([
      { chunk: `${a.id}:7`, file: a.id, title: "Plaint", type: "plaint", page: 4, text: "z".repeat(400) },
    ]);
    expect(s.searched[0]!.fileIds).toBeUndefined();
  });

  it("narrows by files and types, and says which files are not searchable yet", async () => {
    const s = setup([a, b, c], {}, [hit(b, 0, 2)]);
    const r = await s.search({ query: "x", types: ["affidavit"] });
    expect(s.searched[0]!.fileIds).toEqual([b.id]);
    expect(r.note).toMatch(/c\.pdf \(read its pages with fileRead\)/);
    await s.search({ query: "x", files: [a.id] });
    expect(s.searched[1]!.fileIds).toEqual([a.id]);
    expect(await s.search({ query: "x", files: ["nope"] })).toMatch(/No such case file/);
    expect(await s.search({ query: "x", types: ["deed"] })).toMatch(/No case file of type deed/);
    expect(await s.search({ query: "x", files: [c.id] })).toMatch(/Not searchable yet/);
  });
});

describe("fileCard", () => {
  const lease = file("a", {
    title: "Lease",
    docType: "lease",
    pages: 1,
    dates: [{ date: "2021-03-01", what: "signed" }],
    parties: [{ name: "Perera", role: "lessor" }],
    lawsCited: ["s. 2, Rent Act No. 7 of 1972"],
  });
  const aff = (i: number) => ({
    ...file("b", { docType: "affidavit" }),
    id: `bbbbbbbb-0000-4000-8000-00000000000${i}`,
  });
  const scan = file("c", { docType: "deed", state: "unreadable" });

  it("lists every file in one line each with no input", async () => {
    const { card } = setup([lease, scan], {});
    expect(await card({})).toEqual({
      files: [
        { file: lease.id, title: "Lease", type: "lease", pages: 1 },
        { file: scan.id, title: "c.pdf", type: "deed", pages: null, state: "no readable text" },
      ],
    });
  });

  it("gives full cards by file with the summary read on demand, and by type up to the cap", async () => {
    const affs = Array.from({ length: CARDS + 2 }, (_, i) => aff(i));
    const { card } = setup([lease, ...affs], {}, [], { [lease.id]: "A three-year lease." });
    const r = await card({ files: [lease.id] });
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({
      file: lease.id,
      parties: [{ name: "Perera", role: "lessor" }],
      lawsCited: ["s. 2, Rent Act No. 7 of 1972"],
      summary: "A three-year lease.",
    });
    const t = await card({ types: ["affidavit"] });
    expect(t.cards).toHaveLength(CARDS);
    expect(t.more).toMatch(/^2 more/);
    expect(await card({ files: ["nope"] })).toMatch(/No such case file/);
    expect(await card({ types: ["will"] })).toMatch(/No case file of type will/);
    expect(await setup([], {}).card({})).toMatch(/no files yet/);
  });
});
