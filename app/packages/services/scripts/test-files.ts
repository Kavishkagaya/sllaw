// The file pipelines end to end on in-memory implementations (no database, R2, model or Zilliz):
//   pnpm --filter @sllaw/services test-files
import assert from "node:assert/strict";
import type { Card, Categorizer } from "@sllaw/ai";
import type { FileRow, Step, StepEnd } from "@sllaw/db";
import { extract, extractors, NoText, type OcrProvider } from "@sllaw/extract";
import { chunkPages, memoryFileIndex } from "@sllaw/search";
import { getJson, memoryStore } from "@sllaw/storage";
import { keys, runFile, runStep, type Deps, type FileRows } from "../src/files/pipeline";

const WS = "00000000-0000-0000-0000-00000000000a";
const CASE = "00000000-0000-0000-0000-0000000000c1";

function memoryRows(): FileRows & { put(f: Partial<FileRow> & { id: string }): void; rows: Map<string, FileRow> } {
  const rows = new Map<string, FileRow>();
  const base = {
    workspaceId: WS, ownerId: "u1", mime: "text/plain", size: 0, sha256: null, uploadState: "stored",
    extractState: null, extractBy: null, extractError: null, categorizeState: null, categorizeBy: null, categorizeError: null,
    indexState: null, indexBy: null, indexError: null, pages: null, chunks: null, category: null, meta: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  return {
    rows,
    put: (f) => void rows.set(f.id, { ...base, name: `${f.id}.txt`, ...f } as FileRow),
    get: async (id) => rows.get(id) ?? null,
    async claim(id, step: Step) {
      const f = rows.get(id);
      if (!f || f.uploadState !== "stored" || f[`${step}State`] !== "pending") return null;
      const g = { ...f, [`${step}State`]: "running" };
      rows.set(id, g);
      return g;
    },
    async end(id, step: Step, e: StepEnd) {
      const f = rows.get(id)!;
      rows.set(id, { ...f, ...e.set, [`${step}State`]: e.state, [`${step}By`]: e.by ?? null, [`${step}Error`]: e.error ?? null });
    },
    scopes: async () => [`case:${CASE}`],
  };
}

const card: Card = {
  docType: "plaint", title: "Plaint", language: "en", summary: "The plaintiff sues for rent.",
  parties: [{ name: "A. Perera", role: "plaintiff" }], dates: [{ date: "2024-03-01", what: "filed" }],
  court: "District Court of Colombo", caseNumbers: ["DC Colombo 123/L"], lawsCited: ["s. 22 of the Rent Act"], tags: ["rent"],
};
let categorized = 0;
const categorizer: Categorizer = { by: "fake@1", categorize: async () => (categorized++, card) };

const setup = () => {
  const rows = memoryRows(), store = memoryStore(), index = memoryFileIndex();
  const d: Deps = { rows, store, extract: (b, m, n) => extract(b, m, n), categorizer, index };
  return { rows, store, index, d };
};
const pdf = (pages: string[]) => {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    const s = t ? `BT /F1 12 Tf 72 720 Td (${t}) Tj ET` : "";
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return enc(out);
};
const steps = { extractState: "pending", categorizeState: "pending", indexState: "pending" } as const;
const enc = (s: string) => new TextEncoder().encode(s);

// 1. a text file runs all three steps; content lands in the store, metadata on the row, chunks in the index
{
  const { rows, store, index, d } = setup();
  rows.put({ id: "f1", ...steps });
  const plaint = "PLAINT\n\nThe plaintiff A. Perera states that the defendant owes rent under the Rent Act.\n\n" + "More facts. ".repeat(300);
  await store.put(keys.original("f1"), enc(plaint), "text/plain");
  assert.deepEqual(await runFile("f1", d), { extract: "done", categorize: "done", index: "done" });
  const f = rows.rows.get("f1")!;
  assert.equal(f.extractBy, "text@1");
  assert.equal(f.sha256?.length, 64);
  assert.equal(f.category, "plaint");
  assert.equal((f.meta as any).summary, undefined, "the summary is content: not on the row");
  assert.equal((f.meta as any).court, "District Court of Colombo");
  assert.equal((await getJson<Card>(store, keys.card("f1")))!.summary, card.summary);
  assert.ok(f.chunks! >= 3, `chunks: ${f.chunks}`);
  assert.equal(index.rows().length, f.chunks);
  assert.ok(index.rows().every((r) => r.scopes[0] === `case:${CASE}`));
  assert.deepEqual(store.keys(), ["files/f1/card.json", "files/f1/chunks.json", "files/f1/extract.json", "files/f1/original"]);
  // scope is enforced in the query: another case sees nothing
  assert.equal((await index.search("rent", { workspaceId: WS, scopes: [`case:${CASE}`] }))[0]?.fileId, "f1");
  assert.equal((await index.search("rent", { workspaceId: WS, scopes: ["case:other"] })).length, 0);
  // done steps do not run again
  assert.deepEqual(await runFile("f1", d), {});
}

// 2. an asset needs no step: stored is the end
{
  const { rows, store, d } = setup();
  rows.put({ id: "logo", mime: "image/png", name: "logo.png" });
  await store.put(keys.original("logo"), new Uint8Array([137, 80, 78, 71]), "image/png");
  assert.deepEqual(await runFile("logo", d), {});
  assert.deepEqual(store.keys(), ["files/logo/original"]);
}

// 3. a format nothing reads: extract says no_text, the steps after it wait (no model call, nothing indexed)
{
  const { rows, store, index, d } = setup();
  rows.put({ id: "img", mime: "image/jpeg", name: "scan.jpg", ...steps });
  await store.put(keys.original("img"), new Uint8Array([255, 216, 255]), "image/jpeg");
  const before = categorized;
  assert.deepEqual(await runFile("img", d), { extract: "no_text" });
  assert.match(rows.rows.get("img")!.extractError!, /^unsupported/);
  assert.equal(rows.rows.get("img")!.categorizeState, "pending");
  assert.equal(categorized, before);
  assert.equal(index.rows().length, 0);
}

// 4. one step failing does not stop the others: categorize throws, index still runs
{
  const { rows, store, index, d } = setup();
  d.categorizer = { by: "broken@1", categorize: async () => { throw new Error("model down"); } };
  rows.put({ id: "f2", ...steps });
  await store.put(keys.original("f2"), enc("An affidavit sworn by the petitioner about the land."), "text/plain");
  assert.deepEqual(await runFile("f2", d), { extract: "done", categorize: "failed", index: "done" });
  assert.equal(rows.rows.get("f2")!.categorizeError, "model down");
  assert.equal(index.rows().length, 1);
}

// 5. a missing original fails extract with a reason, no throw
{
  const { rows, d } = setup();
  rows.put({ id: "gone", ...steps });
  assert.deepEqual(await runFile("gone", d), { extract: "failed" });
}

// 6. not stored yet: nothing runs
{
  const { rows, d } = setup();
  rows.put({ id: "up", uploadState: "pending", ...steps });
  assert.deepEqual(await runFile("up", d), {});
}

// 7. PDFs: a text layer is read page by page; a page-less (scanned) PDF needs OCR
{
  const long = "The petitioner states that the respondent unlawfully entered the land in dispute.";
  const x = await extract(pdf([long, long.replace("petitioner", "plaintiff")]), "application/pdf", "p.pdf");
  assert.equal(x.by, "unpdf@1");
  assert.equal(x.pages.length, 2);
  assert.match(x.pages[1]!.text, /plaintiff/);
  await assert.rejects(extract(pdf(["", ""]), "application/pdf", "scan.pdf"), (e) => e instanceof NoText && e.reason === "needs_ocr");
}

// 8. chunks: never across a page, never over 1500 chars, ids stable
{
  const cs = chunkPages("f", [{ n: 1, text: "a. ".repeat(1200) }, { n: 2, text: "Short page." }]);
  assert.ok(cs.every((c) => c.text.length <= 1500));
  assert.deepEqual(cs.map((c) => c.id), cs.map((_, i) => `f:${i}`));
  assert.equal(cs.at(-1)!.page, 2);
  assert.equal(cs.at(-1)!.text, "Short page.");
}

// 9. OCR: only pages without a text layer go to the provider, in batches; text pages are kept as read
{
  const calls: number[] = [];
  const fake: OcrProvider = {
    by: "fake-ocr@1",
    async ocr(file, n) {
      assert.ok(["application/pdf", "image/png"].includes(file.mime));
      calls.push(n);
      return Array.from({ length: n }, (_, i) => `ocr text ${i}`);
    },
  };
  const long = "The petitioner states that the respondent unlawfully entered the land in dispute.";
  const pages = Array.from({ length: 20 }, (_, i) => (i === 0 ? long : ""));
  const x = await extract(pdf(pages), "application/pdf", "scan.pdf", extractors(fake));
  assert.equal(x.by, "unpdf+ocr:fake-ocr@1@1");
  assert.equal(x.pages.length, 20);
  assert.match(x.pages[0]!.text, /petitioner/);
  assert.equal(x.pages[1]!.text, "ocr text 0");
  assert.deepEqual([...calls].sort((a, b) => a - b), [3, 8, 8]); // 19 scanned pages in batches of 8
  // images go to OCR too, and only when a provider is set
  const img = await extract(new Uint8Array([1, 2, 3]), "image/png", "photo.png", extractors(fake));
  assert.equal(img.pages[0]!.text, "ocr text 0");
  await assert.rejects(extract(new Uint8Array([1]), "image/png", "photo.png"), (e) => e instanceof NoText && e.reason === "unsupported");
}

// 10. categorize and index run side by side after extract
{
  const { rows, store, d } = setup();
  let inFlight = 0, overlap = false;
  const slow = <T>(f: () => Promise<T>) => async () => {
    inFlight++;
    if (inFlight > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 30));
    try { return await f(); } finally { inFlight--; }
  };
  const realUpsert = d.index.upsert.bind(d.index);
  d.categorizer = { by: "slow@1", categorize: slow(async () => card) };
  d.index = { ...d.index, upsert: (c, a) => slow(() => realUpsert(c, a))() };
  rows.put({ id: "par", ...steps });
  await store.put(keys.original("par"), enc("A short plaint about rent arrears."), "text/plain");
  assert.deepEqual(await runFile("par", d), { extract: "done", categorize: "done", index: "done" });
  assert.ok(overlap, "categorize and index did not overlap");
}

// 11. workflow retries: a throw with retries left puts the step back to pending and rethrows; the last attempt records it
{
  const { rows, store, d } = setup();
  let n = 0;
  d.categorizer = { by: "flaky@1", categorize: async () => { if (++n < 3) throw new Error("timeout"); return card; } };
  rows.put({ id: "r", ...steps });
  await store.put(keys.original("r"), enc("An appeal against the judgment."), "text/plain");
  await runStep("r", "extract", d, { retriesLeft: true });
  await assert.rejects(runStep("r", "categorize", d, { retriesLeft: true }), /timeout/);
  assert.equal(rows.rows.get("r")!.categorizeState, "pending");
  assert.equal(rows.rows.get("r")!.categorizeError, "timeout");
  await assert.rejects(runStep("r", "categorize", d, { retriesLeft: true }), /timeout/);
  assert.equal(await runStep("r", "categorize", d, { retriesLeft: false }), "done");
  assert.equal(rows.rows.get("r")!.categorizeError, null);
  // out of retries: recorded failed, no throw
  d.categorizer = { by: "down@1", categorize: async () => { throw new Error("down"); } };
  rows.put({ id: "r2", ...steps });
  await store.put(keys.original("r2"), enc("A letter of demand."), "text/plain");
  await runStep("r2", "extract", d);
  assert.equal(await runStep("r2", "categorize", d, { retriesLeft: false }), "failed");
}

console.log("test-files: all passed");
