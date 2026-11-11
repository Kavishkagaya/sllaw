// The case-file gold set (docs/features/file-types.json): 20 text files with known types and, for the 8 types with
// fields, the fields a lawyer relies on. Then the reader is scored on it.
//   pnpm --filter @sllaw/services gold-files write    14 documents written by WRITER (not the reader's model)
//   pnpm --filter @sllaw/services gold-files label    drafts the labels of the 6 public files, for the user to check
//   pnpm --filter @sllaw/services gold-files eval     types (Jev + fallback, and the files model alone), fields,
//                                                     steps, cost and time per file, and a 300-page joined file
// Public files: 2 Acts and a gazette from the corpus; 3 Court of Appeal PDFs from lawyer-free public pages, fetched
// into memory each run and never saved (a one-off exception to "no downloads", user 2026-11-11).
import { readFileSync, writeFileSync } from "node:fs";
import { classify, DOC_TYPES, type DocType, FIELDS, type FieldValue, type Page, read, STEPS } from "@sllaw/ai";
import { docWithChunks } from "@sllaw/etl_db";
import { extract } from "@sllaw/extract";
import { flushUsage, type Metered, setUsageSink, withUsage } from "@sllaw/usage";
import { gateway, generateText, Output } from "ai";
import { z } from "zod";

const WRITER = "google/gemini-3-flash"; // writes the documents and judges fields: not the DeepSeek reader
const DIR = new URL("./gold-files/", import.meta.url);
const WRITTEN = new URL("written.json", DIR);
const PUBLIC = new URL("public.json", DIR);

type Labelled = { id: string; docType: DocType; language: "en" | "si" | "ta"; fields: Record<string, FieldValue> };
type Written = Labelled & { pages: string[] };
type Public = Labelled & { source: string }; // a corpus key or a URL

const PUBLIC_SOURCES: Omit<Public, "fields">[] = [
  { id: "act-9-2021", docType: "legislation", language: "en", source: "act:9/2021" },
  { id: "act-8-2024", docType: "legislation", language: "en", source: "act:8/2024" },
  { id: "gazette-2289-40", docType: "gazette", language: "en", source: "gazette:2289/40" },
  {
    id: "ca-dc-480-2000",
    docType: "judgment",
    language: "en",
    source: "https://lankalaw.net/wp-content/uploads/ca_judgements/2000/ca-dc-480-2000-f.pdf",
  },
  {
    id: "ca-hcc-14-2023",
    docType: "judgment",
    language: "en",
    source: "https://lankalaw.net/wp-content/uploads/ca_judgements/2023/ca-hcc-14-2023.pdf",
  },
  {
    id: "ca-writ-01-2025-order",
    docType: "order",
    language: "en",
    source: "https://lankalaw.net/wp-content/uploads/ca_judgements/2025/ca-writ-01-2025-order.pdf",
  },
];

// what the writer writes: type, language and the case it is about (ids are stable: labels are checked by them)
const TO_WRITE: { id: string; docType: DocType; language: "en" | "si" | "ta"; brief: string }[] = [
  {
    id: "plaint-en",
    docType: "plaint",
    language: "en",
    brief: "DC Colombo money action on an unpaid loan of Rs. 1,850,000 against two defendants, with interest",
  },
  {
    id: "plaint-si",
    docType: "plaint",
    language: "si",
    brief: "DC Kurunegala rei vindicatio action for a paddy land, declaration of title and ejectment",
  },
  {
    id: "answer-en",
    docType: "answer",
    language: "en",
    brief:
      "answer in a DC Gampaha rent and ejectment action: admits the tenancy, denies arrears, claims in reconvention for repairs",
  },
  {
    id: "affidavit-en",
    docType: "affidavit",
    language: "en",
    brief:
      "affidavit of a petitioner supporting an interim injunction against building on a right of way, with marked documents P1-P4",
  },
  {
    id: "affidavit-ta",
    docType: "affidavit",
    language: "ta",
    brief:
      "affidavit in a DC Jaffna testamentary case by the widow, on the heirs and the estate's lands, with marked documents",
  },
  {
    id: "journal-si",
    docType: "journal_entry",
    language: "si",
    brief: "a DC Matara partition case journal: several dated entries, the last fixing the next date for trial",
  },
  {
    id: "journal-en",
    docType: "journal_entry",
    language: "en",
    brief:
      "MC Colombo journal entries in a cheque case: summons served, accused absent, warrant, next date for inquiry",
  },
  {
    id: "deed-si",
    docType: "deed",
    language: "si",
    brief:
      "a deed of transfer of a land in Kandy district with lot, plan number and date, extent, consideration and the notary",
  },
  {
    id: "lease-en",
    docType: "lease",
    language: "en",
    brief:
      "an indenture of lease of a shop in Galle for 5 years at a monthly rent with an advance, attested by a notary",
  },
  {
    id: "demand-en",
    docType: "letter_of_demand",
    language: "en",
    brief: "attorney's letter of demand for Rs. 640,000 for goods sold, payable within 14 days, before action",
  },
  {
    id: "demand-ta",
    docType: "letter_of_demand",
    language: "ta",
    brief: "attorney's letter of demand in Batticaloa to vacate a house and pay arrears of rent by a stated date",
  },
  {
    id: "charges-si",
    docType: "charge_sheet",
    language: "si",
    brief: "a Magistrate's Court charge sheet against two accused for house-breaking and theft under the Penal Code",
  },
  {
    id: "charges-en",
    docType: "charge_sheet",
    language: "en",
    brief: "a Magistrate's Court charge sheet for causing hurt and criminal intimidation, one accused",
  },
  {
    id: "letter-en",
    docType: "letter",
    language: "en",
    brief: "a client's ordinary letter to their lawyer about a meeting and a boundary dispute (no demand, no deadline)",
  },
];

const LANG = { en: "English", si: "Sinhala (in Sinhala script)", ta: "Tamil (in Tamil script)" };

const fieldsZod = (t: DocType) =>
  z.object(
    Object.fromEntries(
      (FIELDS[t] ?? []).map((s) => [
        s.key,
        (s.kind === "list" ? z.array(z.string()) : z.string().nullable()).describe(`${s.label}: ${s.hint}`),
      ]),
    ),
  );

const RULE = `Field values: names, dates, amounts, case numbers and quoted text exactly as written in the document (in
its language and script); descriptive values (cause of action, what happened, holding, averments, offences) in English.
A field the document does not give is null (or [] for a list).`;

// ---- write ------------------------------------------------------------------------------------------------------

async function write() {
  const out: Written[] = [];
  for (const w of TO_WRITE) {
    const { output } = await generateText({
      model: gateway(WRITER),
      system: `You write realistic Sri Lankan court and legal documents for testing a document reader. Follow the
form and practice of Sri Lankan courts (the Civil Procedure Code's forms for plaints, answers and affidavits; court
journals; notarial deeds under the Prevention of Frauds Ordinance and the Notaries Ordinance; Magistrate's Court charge
sheets under the Code of Criminal Procedure Act). Invent names, numbers and places; never a real person. Write the
document as its pages (each about one A4 page of text), then its fields as a lawyer would read them. ${RULE}`,
      prompt: `Write a ${w.docType.replace(/_/g, " ")} in ${LANG[w.language]}: ${w.brief}. 2 to 5 pages.`,
      output: Output.object({
        schema: z.object({ pages: z.array(z.string()).min(1), fields: fieldsZod(w.docType) }),
        name: "document",
      }),
    });
    out.push({ id: w.id, docType: w.docType, language: w.language, pages: output.pages, fields: output.fields });
    console.log(`${w.id}: ${output.pages.length} pages`);
  }
  writeFileSync(WRITTEN, `${JSON.stringify(out, null, 2)}\n`);
}

// ---- public files -----------------------------------------------------------------------------------------------

/** A public file's pages: a corpus document cut into pages of about 3,000 characters, or a PDF read into memory. */
async function publicPages(source: string): Promise<Page[]> {
  if (source.startsWith("https://")) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`${source}: ${r.status}`);
    const x = await extract(new Uint8Array(await r.arrayBuffer()), "application/pdf", source.split("/").pop()!);
    return x.pages.map((p) => ({ page: p.n, text: p.text }));
  }
  const d = await docWithChunks(source);
  if (!d) throw new Error(`${source}: not in the corpus`);
  const pages: Page[] = [];
  let cur = "";
  for (const c of d.chunks) {
    cur += `${c.text}\n\n`;
    if (cur.length > 3000) pages.push({ page: pages.length + 1, text: cur }), (cur = "");
  }
  if (cur) pages.push({ page: pages.length + 1, text: cur });
  return pages;
}

/** Drafts the 6 public files' fields with the writer model; the user checks them in public.json. */
async function label() {
  const out: Public[] = [];
  for (const p of PUBLIC_SOURCES) {
    const pages = await publicPages(p.source);
    let fields: Record<string, FieldValue> = {};
    if (FIELDS[p.docType]) {
      const { output } = await generateText({
        model: gateway(WRITER),
        system: `You label a Sri Lankan legal document for a test: read it all and give its fields. ${RULE}`,
        prompt: `Type: ${p.docType}\n\n<document>\n${pages.map((x) => `[page ${x.page}]\n${x.text}`).join("\n")}\n</document>`,
        output: Output.object({ schema: fieldsZod(p.docType), name: "fields" }),
      });
      fields = output;
    }
    out.push({ ...p, fields });
    console.log(`${p.id}: ${pages.length} pages`);
  }
  writeFileSync(PUBLIC, `${JSON.stringify(out, null, 2)}\n`);
}

// ---- eval -------------------------------------------------------------------------------------------------------

const judge = z.object({ keys: z.array(z.object({ key: z.string(), match: z.boolean(), why: z.string() })) });

/** Which of the label's fields the reader got: one judge call; a null label must be read as empty. */
async function score(f: Labelled, got: Record<string, FieldValue>) {
  const specs = FIELDS[f.docType] ?? [];
  if (!specs.length) return { right: 0, of: 0, misses: [] as string[] };
  const { output } = await generateText({
    model: gateway(WRITER),
    system: `You check a document reader's fields against the correct ones, as a lawyer would. A field matches when
it says the same thing: same names, numbers, amounts and dates (any format: 's. 443' and 'Section 443 of the Penal
Code' match); correct extra detail from the document (an address beside a name, a date beside a marked document)
is not a miss. A list matches when it covers the correct items (wording and order may differ; a missing or wrong item
is a miss). A descriptive field matches when its meaning is the same and it holds the main point. A miss is: a value
missing, wrong, or given where the correct one is null or [] (invented).`,
    prompt: JSON.stringify({ fields: specs.map((s) => s.key), correct: f.fields, reader: got }),
    output: Output.object({ schema: judge, name: "check" }),
  });
  const misses = output.keys.filter((k) => !k.match).map((k) => `${k.key}: ${k.why}`);
  return { right: specs.length - misses.length, of: specs.length, misses };
}

async function evaluate() {
  const written: Written[] = JSON.parse(readFileSync(WRITTEN, "utf8"));
  const pub: Public[] = JSON.parse(readFileSync(PUBLIC, "utf8"));
  const files: (Labelled & { pages: Page[] })[] = [
    ...written.map((w) => ({ ...w, pages: w.pages.map((text, i) => ({ page: i + 1, text })) })),
    ...(await Promise.all(pub.map(async (p) => ({ ...p, pages: await publicPages(p.source) })))),
  ];
  // the long file: the English plaint first, then every other file after it as annexures, to 300 pages
  const plaint = files.find((f) => f.id === "plaint-en")!;
  const rest = files.filter((f) => f !== plaint).flatMap((f) => f.pages.map((p) => p.text));
  const long: Page[] = plaint.pages
    .map((p) => p.text)
    .concat(Array.from({ length: 300 }, (_, i) => rest[i % rest.length]!))
    .slice(0, 300)
    .map((text, i) => ({ page: i + 1, text }));

  const events: Metered[] = [];
  setUsageSink(async (e) => void events.push(...e));
  const cost = (ref: string) => events.filter((e) => e.ref === ref).reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const ws = "00000000-0000-4000-8000-000000000000";

  const rows: Record<string, unknown>[] = [];
  for (const f of files) {
    const t0 = Date.now();
    const jev = await withUsage({ workspaceId: ws, task: "eval", ref: f.id }, () =>
      classify({ workspaceId: ws, filename: `${f.id}.pdf`, pages: f.pages }),
    );
    // fields are read with the correct type, so a wrong type does not hide how well the fields are read
    const r = await withUsage({ workspaceId: ws, task: "eval", ref: f.id }, () =>
      read({ workspaceId: ws, filename: `${f.id}.pdf`, pages: f.pages, docType: f.docType }),
    );
    const ms = Date.now() - t0;
    const alone = await withUsage({ workspaceId: ws, task: "eval", ref: `${f.id}:alone` }, () =>
      classify({ workspaceId: ws, filename: `${f.id}.pdf`, pages: f.pages, using: "" }),
    );
    await flushUsage();
    const s = await score(f, r.card.fields);
    rows.push({
      id: f.id,
      lang: f.language,
      type: f.docType,
      jev: jev.docType,
      jevBy: jev.typedBy.startsWith("files:") ? "fallback" : `jev ${jev.typeConfidence?.toFixed(2)}`,
      alone: alone.docType,
      fields: s.of ? `${s.right}/${s.of}` : "-",
      misses: s.misses,
      steps: r.steps,
      usd: Number(cost(f.id).toFixed(5)),
      s: Math.round(ms / 1000),
    });
    console.log(JSON.stringify(rows.at(-1)));
  }

  const t0 = Date.now();
  const lt = await withUsage({ workspaceId: ws, task: "eval", ref: "long" }, () =>
    classify({ workspaceId: ws, filename: "bundle.pdf", pages: long }),
  );
  const lr = await withUsage({ workspaceId: ws, task: "eval", ref: "long" }, () =>
    read({ workspaceId: ws, filename: "bundle.pdf", pages: long, docType: lt.docType }),
  );
  await flushUsage();
  const ls = await score({ ...plaint, docType: "plaint" }, lr.card.fields);

  const right = (k: "jev" | "alone") => rows.filter((r) => r[k] === r.type).length;
  const byLang = (k: "jev" | "alone") =>
    Object.fromEntries(
      ["en", "si", "ta"].map((l) => {
        const x = rows.filter((r) => r.lang === l);
        return [l, `${x.filter((r) => r[k] === r.type).length}/${x.length}`];
      }),
    );
  const fieldRows = rows.filter((r) => r.fields !== "-").map((r) => (r.fields as string).split("/").map(Number));
  const usd = rows.map((r) => r.usd as number);
  const secs = rows.map((r) => r.s as number).sort((a, b) => a - b);
  const summary = {
    files: rows.length,
    types: { jevWithFallback: `${right("jev")}/${rows.length}`, filesModelAlone: `${right("alone")}/${rows.length}` },
    typesByLanguage: { jevWithFallback: byLang("jev"), filesModelAlone: byLang("alone") },
    fields: `${fieldRows.reduce((s, [a]) => s + a!, 0)}/${fieldRows.reduce((s, [, b]) => s + b!, 0)}`,
    maxSteps: Math.max(...rows.map((r) => r.steps as number)),
    usdPerFile: { mean: Number((usd.reduce((a, b) => a + b, 0) / usd.length).toFixed(5)), max: Math.max(...usd) },
    seconds: { median: secs[Math.floor(secs.length / 2)], max: secs.at(-1) },
    long: {
      pages: long.length,
      type: lt.docType,
      steps: lr.steps,
      fields: `${ls.right}/${ls.of}`,
      usd: Number(cost("long").toFixed(5)),
      s: Math.round((Date.now() - t0) / 1000),
    },
    allowed: { steps: STEPS, types: DOC_TYPES.length },
  };
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(new URL("last-eval.json", DIR), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
}

const cmd = process.argv[2];
await (cmd === "write"
  ? write()
  : cmd === "label"
    ? label()
    : cmd === "eval"
      ? evaluate()
      : Promise.reject(new Error("write | label | eval")));
