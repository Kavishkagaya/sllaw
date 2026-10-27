// A case's files as its agent sees them, on in-memory rows and store.
import type { FileRow } from "@sllaw/db";
import { memoryStore, putJson } from "@sllaw/storage";
import { describe, expect, it } from "vitest";
import { caseFilesFrom, chunksReader, summaryReader } from "./case-files";
import { keys } from "./files/pipeline";

const row = (id: string, at: number, over: Partial<FileRow> = {}) =>
  ({
    id,
    name: `${id}.pdf`,
    uploadState: "stored",
    extractState: "done",
    categorizeState: "done",
    indexState: "done",
    pages: 3,
    category: "plaint",
    meta: {
      title: "Plaint",
      language: "en",
      parties: [{ name: "A", role: "plaintiff" }],
      dates: [],
      court: "DC Colombo",
      caseNumbers: ["4521/RE"],
      lawsCited: ["s. 2, Rent Act"],
      tags: ["rent"],
    },
    createdAt: new Date(at),
    ...over,
  }) as FileRow;

describe("caseFilesFrom", () => {
  it("lists files oldest first with state and card, from the rows alone; leaves out failed and deleting uploads", () => {
    const files = caseFilesFrom([
      row("cccccccc-0000", 3, { extractState: "no_text", categorizeState: "pending", indexState: "pending" }),
      row("aaaaaaaa-0000", 1),
      row("bbbbbbbb-0000", 2, { indexState: "running", categorizeState: "running", meta: null, category: null }),
      row("dddddddd-0000", 4, { uploadState: "failed" }),
      row("eeeeeeee-0000", 5, { uploadState: "deleting" }),
      row("ffffffff-0000", 6, { uploadState: "pending", extractState: "pending" }),
    ]);
    expect(files.map((f) => [f.id, f.state, f.searchable])).toEqual([
      ["aaaaaaaa-0000", "ready", true],
      ["bbbbbbbb-0000", "ready", false],
      ["cccccccc-0000", "unreadable", false],
      ["ffffffff-0000", "processing", true],
    ]);
    expect(files[0]).toMatchObject({
      title: "Plaint",
      docType: "plaint",
      court: "DC Colombo",
      caseNumbers: ["4521/RE"],
      lawsCited: ["s. 2, Rent Act"],
      tags: ["rent"],
    });
    expect(files[0]!.parties).toEqual([{ name: "A", role: "plaintiff" }]);
    expect(files[1]).toMatchObject({ title: null, court: null, parties: [], caseNumbers: [] });
  });
});

describe("chunksReader", () => {
  it("reads a case file's chunks once (chunks.json), cuts them from the extract when not indexed, nothing else", async () => {
    const store = memoryStore();
    await putJson(store, keys.chunks("f1"), [{ id: "f1:0", fileId: "f1", n: 0, page: 1, text: "one" }]);
    await putJson(store, keys.extract("f2"), {
      by: "x",
      pages: [
        { n: 1, text: "a" },
        { n: 2, text: "b" },
      ],
    });
    await putJson(store, keys.chunks("other"), [{ id: "other:0", fileId: "other", n: 0, page: 1, text: "secret" }]);
    let made = 0;
    const read = chunksReader([{ id: "f1" } as never, { id: "f2" } as never], () => (made++, store));
    expect(await read("f1")).toEqual([{ n: 0, page: 1, text: "one" }]);
    await read("f1");
    expect(made).toBe(1);
    expect(await read("f2")).toEqual([
      { n: 0, page: 1, text: "a" },
      { n: 1, page: 2, text: "b" },
    ]);
    expect(await read("other")).toBeNull();
  });
});

describe("summaryReader", () => {
  it("reads a case file's summary from its card, nothing of another file", async () => {
    const store = memoryStore();
    await putJson(store, keys.card("f1"), { summary: "It claims arrears." });
    await putJson(store, keys.card("other"), { summary: "secret" });
    const read = summaryReader([{ id: "f1" } as never, { id: "f2" } as never], () => store);
    expect(await read("f1")).toBe("It claims arrears.");
    expect(await read("f2")).toBeNull();
    expect(await read("other")).toBeNull();
  });
});
