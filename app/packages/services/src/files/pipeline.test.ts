// The file pipelines on in-memory rows, store, index and categorizer: no database, R2, model or Zilliz.
import type { Card, Categorizer } from "@sllaw/ai";
import type { FileRow, Step, StepEnd } from "@sllaw/db";
import { extract } from "@sllaw/extract";
import { memoryFileIndex } from "@sllaw/search";
import { getJson, memoryStore } from "@sllaw/storage";
import { describe, expect, it } from "vitest";
import { keys, runFile, runStep, type Deps, type FileEvent, type FileRows } from "./pipeline";

const WS = "00000000-0000-0000-0000-00000000000a";
const CASE = "00000000-0000-0000-0000-0000000000c1";
const enc = (s: string) => new TextEncoder().encode(s);
const steps = { extractState: "pending", categorizeState: "pending", indexState: "pending" } as const;

let clock = Date.now();
const tick = () => new Date(++clock); // row writes in order, never two at the same ms

/** The rows as claimStep / endStep keep them: claim pending (or running and left by the same run), end only running. */
function memoryRows(): FileRows & { put(f: Partial<FileRow> & { id: string }): void; rows: Map<string, FileRow> } {
  const rows = new Map<string, FileRow>();
  const base = {
    workspaceId: WS, ownerId: "u1", mime: "text/plain", size: 0, sha256: null, uploadState: "stored",
    extractState: null, extractBy: null, extractError: null, categorizeState: null, categorizeBy: null, categorizeError: null,
    indexState: null, indexBy: null, indexError: null, pages: null, chunks: null, category: null, meta: null,
    scopes: [`case:${CASE}`], runId: null, createdAt: new Date(), updatedAt: new Date(),
  };
  return {
    rows,
    put: (f) => void rows.set(f.id, { ...base, name: `${f.id}.txt`, ...f } as FileRow),
    get: async (id) => rows.get(id) ?? null,
    async claim(id, step: Step, runId?: string) {
      const f = rows.get(id);
      const state = f?.[`${step}State`];
      if (!f || f.uploadState !== "stored" || !(state === "pending" || (state === "running" && runId && f.runId === runId))) return null;
      const g = { ...f, [`${step}State`]: "running", updatedAt: tick() };
      rows.set(id, g);
      return g;
    },
    async end(id, step: Step, e: StepEnd) {
      const f = rows.get(id);
      if (!f || f[`${step}State`] !== "running") return null;
      const at = tick();
      rows.set(id, { ...f, ...e.set, [`${step}State`]: e.state, [`${step}By`]: e.by ?? null, [`${step}Error`]: e.error ?? null, updatedAt: at });
      return at;
    },
  };
}

const card: Card = {
  docType: "plaint", title: "Plaint", language: "en", summary: "The plaintiff sues for rent.",
  parties: [{ name: "A. Perera", role: "plaintiff" }], dates: [{ date: "2024-03-01", what: "filed" }],
  court: "District Court of Colombo", caseNumbers: ["DC Colombo 123/L"], lawsCited: ["s. 22 of the Rent Act"], tags: ["rent"],
};

function setup() {
  const rows = memoryRows(), store = memoryStore(), index = memoryFileIndex();
  let calls = 0;
  const categorizer: Categorizer = { by: "fake@1", categorize: async () => (calls++, card) };
  const d: Deps = { rows, store, extract: (b, m, n, ctx) => extract(b, m, n, undefined, ctx), categorizer, index };
  /** A file row with its original in the store. */
  const file = async (id: string, text: string | Uint8Array, row: Partial<FileRow> = {}) => {
    rows.put({ id, ...steps, ...row });
    await store.put(keys.original(id), typeof text === "string" ? enc(text) : text, row.mime ?? "text/plain");
  };
  return { rows, store, index, d, file, categorized: () => calls };
}

describe("a file through its steps", () => {
  it("runs extract, categorize and index: content in the store, metadata on the row, chunks in the index", async () => {
    const { rows, store, index, d, file } = setup();
    await file("f1", "PLAINT\n\nThe plaintiff A. Perera states that the defendant owes rent under the Rent Act.\n\n" + "More facts. ".repeat(300));
    expect(await runFile("f1", d)).toEqual({ extract: "done", categorize: "done", index: "done" });

    const f = rows.rows.get("f1")!;
    expect(f).toMatchObject({ extractBy: "text@1", category: "plaint" });
    expect(f.sha256).toHaveLength(64);
    expect(f.meta).toMatchObject({ court: "District Court of Colombo" });
    expect(f.meta).not.toHaveProperty("summary"); // content: in the store, not on the row
    expect((await getJson<Card>(store, keys.card("f1")))!.summary).toBe(card.summary);
    expect(f.chunks).toBeGreaterThanOrEqual(3);
    expect(index.rows()).toHaveLength(f.chunks!);
    expect(index.rows().every((r) => r.scopes[0] === `case:${CASE}`)).toBe(true);
    expect(store.keys()).toEqual(["files/f1/card.json", "files/f1/chunks.json", "files/f1/extract.json", "files/f1/original"]);
  });

  it("enforces scope in the index query: another case sees nothing", async () => {
    const { index, d, file } = setup();
    await file("f1", "A plaint about rent arrears under the Rent Act.");
    await runFile("f1", d);
    expect((await index.search("rent", { workspaceId: WS, scopes: [`case:${CASE}`] }))[0]?.fileId).toBe("f1");
    expect(await index.search("rent", { workspaceId: WS, scopes: ["case:other"] })).toHaveLength(0);
  });

  it("does not run done steps again", async () => {
    const { d, file } = setup();
    await file("f1", "A short plaint.");
    await runFile("f1", d);
    expect(await runFile("f1", d)).toEqual({});
  });

  it("runs nothing for a file that needs no step (an asset)", async () => {
    const { store, d, file } = setup();
    await file("logo", new Uint8Array([137, 80, 78, 71]), { mime: "image/png", name: "logo.png", extractState: null, categorizeState: null, indexState: null });
    expect(await runFile("logo", d)).toEqual({});
    expect(store.keys()).toEqual(["files/logo/original"]);
  });

  it("runs nothing before the upload is stored", async () => {
    const { d, file } = setup();
    await file("up", "text", { uploadState: "pending" });
    expect(await runFile("up", d)).toEqual({});
  });

  it("runs categorize and index side by side after extract", async () => {
    const { d, file } = setup();
    let inFlight = 0, overlap = false;
    const slow = <T>(f: () => Promise<T>) => async () => {
      if (++inFlight > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await f();
      } finally {
        inFlight--;
      }
    };
    const upsert = d.index.upsert.bind(d.index);
    d.categorizer = { by: "slow@1", categorize: slow(async () => card) };
    d.index = { ...d.index, upsert: (c, a) => slow(() => upsert(c, a))() };
    await file("par", "A short plaint about rent arrears.");
    expect(await runFile("par", d)).toEqual({ extract: "done", categorize: "done", index: "done" });
    expect(overlap).toBe(true);
  });
});

describe("when a step cannot finish", () => {
  it("a format nothing reads is no_text, not retryable; the steps after it wait", async () => {
    const { rows, index, d, file, categorized } = setup();
    await file("img", new Uint8Array([255, 216, 255]), { mime: "image/jpeg", name: "scan.jpg" });
    expect(await runFile("img", d)).toEqual({ extract: "no_text" });
    const f = rows.rows.get("img")!;
    expect(f.extractError).toMatchObject({ message: expect.stringMatching(/^unsupported/), retryable: false });
    expect(f.categorizeState).toBe("pending");
    expect(categorized()).toBe(0);
    expect(index.rows()).toHaveLength(0);
  });

  it("one step failing does not stop the others", async () => {
    const { rows, index, d, file } = setup();
    d.categorizer = { by: "broken@1", categorize: async () => { throw new Error("model down"); } };
    await file("f2", "An affidavit sworn by the petitioner about the land.");
    expect(await runFile("f2", d)).toEqual({ extract: "done", categorize: "failed", index: "done" });
    expect(rows.rows.get("f2")!.categorizeError).toEqual({ message: "model down", retryable: true });
    expect(index.rows()).toHaveLength(1);
  });

  it("a missing original fails extract, not retryable, without a throw", async () => {
    const { rows, d } = setup();
    rows.put({ id: "gone", ...steps });
    expect(await runFile("gone", d)).toEqual({ extract: "failed" });
    expect(rows.rows.get("gone")!.extractError!.retryable).toBe(false);
  });

  it("a file deleted while its index step embeds leaves no vectors behind", async () => {
    const { rows, index, d, file } = setup();
    await file("del", "A deed of transfer of the land.");
    await runStep("del", "extract", d);
    const upsert = d.index.upsert.bind(d.index);
    // deleteFile runs between the embedding and the write: it removes nothing yet, and the row is gone
    d.index = { ...d.index, upsert: async (c, a) => { await d.index.remove("del"); rows.rows.delete("del"); await upsert(c, a); } };
    expect(await runStep("del", "index", d)).toBeNull();
    expect(index.rows()).toHaveLength(0);
  });
});

describe("retries", () => {
  it("a retryable error with retries left goes back to pending and is thrown; the last attempt records it", async () => {
    const { rows, d, file } = setup();
    let n = 0;
    d.categorizer = { by: "flaky@1", categorize: async () => { if (++n < 3) throw new Error("timeout"); return card; } };
    await file("r", "An appeal against the judgment.");
    await runStep("r", "extract", d, { retriesLeft: true });
    await expect(runStep("r", "categorize", d, { retriesLeft: true })).rejects.toThrow(/timeout/);
    expect(rows.rows.get("r")).toMatchObject({ categorizeState: "pending", categorizeError: { message: "timeout", retryable: true } });
    await expect(runStep("r", "categorize", d, { retriesLeft: true })).rejects.toThrow(/timeout/);
    expect(await runStep("r", "categorize", d, { retriesLeft: false })).toBe("done");
    expect(rows.rows.get("r")!.categorizeError).toBeNull();
  });

  it("out of retries: recorded failed, no throw", async () => {
    const { d, file } = setup();
    d.categorizer = { by: "down@1", categorize: async () => { throw new Error("down"); } };
    await file("r2", "A letter of demand.");
    await runStep("r2", "extract", d);
    expect(await runStep("r2", "categorize", d, { retriesLeft: false })).toBe("failed");
  });

  it("an unreadable file fails at once even with retries left", async () => {
    const { rows, d, file } = setup();
    await file("bad", "%PDF-1.4 not really a pdf", { mime: "application/pdf", name: "bad.pdf" });
    expect(await runStep("bad", "extract", d, { retriesLeft: true })).toBe("failed");
    expect(rows.rows.get("bad")!.extractError!.retryable).toBe(false);
  });

  it("a request refused for good (4xx) fails at once even with retries left", async () => {
    const { rows, d, file } = setup();
    d.categorizer = { by: "refused@1", categorize: async () => { throw Object.assign(new Error("invalid request"), { status: 400 }); } };
    await file("ref", "A plaint about a boundary dispute.");
    await runStep("ref", "extract", d);
    expect(await runStep("ref", "categorize", d, { retriesLeft: true })).toBe("failed");
    expect(rows.rows.get("ref")!.categorizeError).toEqual({ message: "invalid request", retryable: false });
  });

  it("a step cut off mid-run is claimed back by its own run's retry, not by another run", async () => {
    const { d, file } = setup();
    await file("cut", "An order of the District Court.", { extractState: "running", runId: "run-1" });
    expect(await runStep("cut", "extract", d, { runId: "run-0" })).toBe("busy");
    expect(await runStep("cut", "extract", d, { runId: "run-1" })).toBe("done");
  });
});

describe("the state writer", () => {
  it("gets every state runStep writes, in order, each with the time its row was written", async () => {
    const { rows, d, file } = setup();
    const events: FileEvent[] = [];
    const writer = { write: async (e: FileEvent) => void events.push(e) };
    await file("w", "A notice to quit the premises.");
    await runStep("w", "extract", d, { writer });
    await runStep("w", "index", d, { writer });
    expect(events.map((e) => `${e.step}:${e.state}`)).toEqual(["extract:running", "extract:done", "index:running", "index:done"]);
    expect(events.every((e, i) => i === 0 || e.at > events[i - 1]!.at)).toBe(true);
    expect(events.at(-1)!.at).toBe(rows.rows.get("w")!.updatedAt.getTime()); // the last event is the row as it is now
  });

  it("gets nothing for a step another run holds", async () => {
    const { d, file } = setup();
    const events: FileEvent[] = [];
    await file("held", "text", { extractState: "running" });
    expect(await runStep("held", "extract", d, { writer: { write: async (e) => void events.push(e) } })).toBe("busy");
    expect(events).toHaveLength(0);
  });
});
