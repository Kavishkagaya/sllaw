// Reading a case file into its card (docs/features/file-types.json), in two steps:
//   1. classify: the decision model (Jev) names the type from the first pages; when it is unsure or fails, the
//      files model names it instead.
//   2. read: a small agent pages through the whole file (at most STEPS steps) and fills the generic card plus the
//      fields of its type (doc-types.ts).
// The card is metadata on the file's row, except the summary, which is content and goes to the blob store.
import { experimental_decide as decide, gateway, generateText, hasToolCall, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { CLASSIFY_MODEL, meterDecision, model } from "../models";
import { data, inline } from "../prompt/guard";
import { DOC_TYPE_HINTS, DOC_TYPES, type DocType, FIELDS, type FieldSpec } from "./doc-types";

export { DOC_TYPES, type DocType, FIELDS, type FieldSpec } from "./doc-types";

export type Page = { page: number; text: string };
/** A type-specific field's value: text, a list, or null when the document does not give it. */
export type FieldValue = string | string[] | null;

const generic = z.object({
  title: z.string().describe("a short title a lawyer would give it, e.g. 'Plaint, DC Colombo 12345/L'"),
  language: z.enum(["en", "si", "ta", "mixed"]),
  summary: z.string().describe("3-6 sentences in English: what it is, who files or writes it, what it asks or says"),
  parties: z.array(
    z.object({
      name: z.string(),
      role: z.string().describe("plaintiff, defendant, petitioner, respondent, accused, witness, lessor ..."),
    }),
  ),
  dates: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD, or YYYY-MM / YYYY when that is all it gives"),
      what: z.string(),
    }),
  ),
  court: z.string().nullable().describe("the court or tribunal, as written; null if none"),
  caseNumbers: z.array(z.string()).describe("case numbers as written, e.g. 'DC Colombo 12345/L', 'SC Appeal 21/2019'"),
  lawsCited: z
    .array(z.string())
    .describe("statutes and sections cited, as written, e.g. 's. 46 of the Civil Procedure Code'"),
  tags: z.array(z.string()).describe("up to 6 short subject tags: 'rent', 'land', 'partition', 'bail' ..."),
});

export type Card = z.infer<typeof generic> & {
  docType: DocType;
  fields: Record<string, FieldValue>;
  /** who named the type: the decision model, the files model, or "lawyer" */
  typedBy: string;
  /** the decision model's probability for the type it named; null when another named it */
  typeConfidence: number | null;
  /** keys the lawyer typed (generic or field keys): a re-read keeps them */
  edited: string[];
};

/** Reads a file's pages and returns its card. `by` is name@version, recorded on the file row (categorize_by). */
export interface Categorizer {
  readonly by: string;
  /** With `docType`, the type is not asked again (the lawyer set it). Stops when `signal` aborts. */
  categorize(input: {
    workspaceId: string;
    filename: string;
    pages: Page[];
    docType?: DocType;
    signal?: AbortSignal;
  }): Promise<Card>;
}

const VERSION = 2; // bump when a prompt, a schema or the steps change: files read before can then be found and redone
export const STEPS = 10; // the reader's steps, the last one only answers
export const SURE = 0.6; // below this probability the decision model's type is asked again of the files model
const CLASSIFY_CHARS = 12_000; // the head the type is named from (Jev reads 32k tokens; Sinhala takes ~1 a char)
const FIRST_CHARS = 30_000; // the whole pages the reader starts with (most files fit)
export const READ_PAGES = 20; // pages a readPages call returns at most
export const READ_CHARS = 30_000; // and characters

/** The pages from..to as one text, each under its page mark, cut at `max` characters. */
export function pageText(pages: Page[], from: number, to: number, max = READ_CHARS) {
  let out = "";
  for (const p of pages) {
    if (p.page < from || p.page > to) continue;
    const add = `[page ${p.page}]\n${p.text}\n\n`;
    if (out.length + add.length > max) return `${out}${add.slice(0, max - out.length)}\n[… cut at ${max} characters]`;
    out += add;
  }
  return out || "(no such pages)";
}

const head = (pages: Page[], max: number) => pageText(pages, 1, pages.length ? pages[pages.length - 1].page : 1, max);

// ---- classify ---------------------------------------------------------------------------------------------------

const isDecisionModel = (id: string) => id.startsWith("typesafe-ai/");

/** Names the file's type: the decision model first; the files model when it is unsure or fails. */
export async function classify(input: {
  workspaceId: string;
  filename: string;
  pages: Page[];
  signal?: AbortSignal;
  /** the decision model to ask first (the eval passes "" to ask the files model alone) */
  using?: string;
}) {
  const { workspaceId, filename, pages, signal, using = CLASSIFY_MODEL } = input;
  const text = `File name: ${filename}\n\n${head(pages, CLASSIFY_CHARS)}`;
  if (isDecisionModel(using)) {
    try {
      const r = await decide({
        model: gateway.decisionModel(using),
        state: text,
        questions: {
          docType: {
            type: "choice",
            instructions:
              "What kind of document from a Sri Lankan lawyer's case file is this? It may be in English, Sinhala or Tamil.",
            criteria: Object.fromEntries(DOC_TYPES.map((t) => [t, DOC_TYPE_HINTS[t]])),
          },
        },
        abortSignal: signal,
        providerOptions: { gateway: { user: workspaceId, tags: ["task:classify"] } },
      });
      meterDecision(workspaceId, using, r.usage, r.providerMetadata);
      const a = r.answers.docType;
      const p = a.probabilities?.[a.choice] ?? null;
      if (DOC_TYPES.includes(a.choice as DocType) && (p == null || p >= SURE))
        return { docType: a.choice as DocType, typedBy: using, typeConfidence: p };
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn("classify: decision model failed, asking the files model", e);
    }
  }
  const { output } = await generateText({
    model: model("files", workspaceId),
    system: "You name the kind of one document from a Sri Lankan lawyer's case file (English, Sinhala or Tamil).",
    prompt: data("document", text),
    output: Output.object({
      schema: z.object({
        docType: z.enum(DOC_TYPES).describe("what kind of document this is; 'other' when none fits"),
      }),
      name: "type",
    }),
    abortSignal: signal,
  });
  return { docType: output.docType, typedBy: `files:${process.env.MODEL_FILES || "default"}`, typeConfidence: null };
}

/** A correction of a card, by the lawyer (case.editFile) or the agent (fileCard's correct): the same bounds both. */
export const cardPatch = z.object({
  docType: z.enum(DOC_TYPES).optional(),
  title: z.string().max(300).optional(),
  summary: z.string().max(5000).optional(),
  court: z.string().max(300).nullable().optional(),
  caseNumbers: z.array(z.string().max(200)).max(50).optional(),
  parties: z
    .array(z.object({ name: z.string().max(300), role: z.string().max(100) }))
    .max(100)
    .optional(),
  dates: z
    .array(z.object({ date: z.string().max(40), what: z.string().max(300) }))
    .max(100)
    .optional(),
  lawsCited: z.array(z.string().max(300)).max(100).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  fields: z
    .record(z.string().max(64), z.union([z.string().max(5000), z.array(z.string().max(1000)).max(100), z.null()]))
    .optional()
    .describe("the type's own fields by key"),
});

// ---- read -------------------------------------------------------------------------------------------------------

const fieldSchema = (s: FieldSpec) =>
  (s.kind === "list" ? z.array(z.string()) : z.string().nullable()).describe(
    `${s.label}: ${s.hint}${s.kind === "list" ? "; [] if the document gives none" : "; null if the document does not give it"}`,
  );

/** The card schema for a type: the generic card and that type's fields. */
export const cardSchema = (docType: DocType) =>
  generic.extend({
    fields: z.object(Object.fromEntries((FIELDS[docType] ?? []).map((s) => [s.key, fieldSchema(s)]))),
  });

const instructions = `You read one document from a Sri Lankan lawyer's case file and fill its card as JSON. Take
everything from the document itself; never guess a party, date, amount or number it does not give: leave that field
null or empty. The document may be in English, Sinhala or Tamil: keep names, dates, amounts, case numbers and quoted
text as written in its language; write the summary and descriptive fields (cause of action, what happened, holding,
offences, averments) in English. A file may hold several documents (a plaint with its annexures): card the main one.
You are shown the file's first pages and told which pages you have not seen. If there are unseen pages, read with
readPages where the fields are before you answer (a plaint's prayer is at its end, a journal's latest entry is last, a
judgment's holding and orders close it). You have ${STEPS - 1} steps for reading at most. Answer by calling submit
once with the card.`;

/** Fills the card of a file whose type is known, reading its pages with a tool, in at most STEPS steps; says how
 *  many it took. */
export async function read(input: {
  workspaceId: string;
  filename: string;
  pages: Page[];
  docType: DocType;
  signal?: AbortSignal;
}) {
  const { workspaceId, filename, pages, docType, signal } = input;
  const last = pages.length ? pages[pages.length - 1].page : 0;
  const readPages = tool({
    description: `Returns pages from..to of this file (at most ${READ_PAGES} pages, ${READ_CHARS} characters).`,
    inputSchema: z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }),
    execute: async ({ from, to }) => data("pages", pageText(pages, from, Math.min(to, from + READ_PAGES - 1))),
  });
  const submit = tool({ description: "Gives the file's card. Call it once, last.", inputSchema: cardSchema(docType) });
  // the whole pages that fit in FIRST_CHARS are shown; the rest the agent reads
  let seen = 0;
  for (let n = 0; seen < pages.length && n + pages[seen].text.length <= FIRST_CHARS; seen++)
    n += pages[seen].text.length;
  seen = Math.max(seen, Math.min(1, pages.length));
  const shown = pageText(pages.slice(0, seen), 1, last, FIRST_CHARS);
  const unseen = seen < pages.length ? `pages ${pages[seen].page}-${last} not seen yet` : "you have seen every page";
  const hint = DOC_TYPE_HINTS[docType];
  const r = await generateText({
    model: model("files", workspaceId),
    system: instructions,
    prompt: `Type: ${docType}${hint ? ` (${hint})` : ""}\nPages: ${last} (${unseen})\n\n${data("document", `File name: ${inline(filename)}\n\n${shown}`)}`,
    tools: { readPages, submit },
    toolChoice: "required",
    stopWhen: [hasToolCall("submit"), stepCountIs(STEPS)],
    prepareStep: ({ stepNumber }) => (stepNumber >= STEPS - 1 ? { activeTools: ["submit"] } : {}),
    abortSignal: signal,
  });
  const call = r.steps.flatMap((s) => s.toolCalls).find((c) => c.toolName === "submit");
  if (!call) throw new Error(`read: no card after ${r.steps.length} steps`);
  return {
    card: cardSchema(docType).parse(call.input) as z.infer<typeof generic> & { fields: Record<string, FieldValue> },
    steps: r.steps.length,
  };
}

export const llmCategorizer: Categorizer = {
  by: `llm:${CLASSIFY_MODEL}+${process.env.MODEL_FILES || "default"}@${VERSION}`,
  async categorize({ workspaceId, filename, pages, docType, signal }) {
    const t = docType
      ? { docType, typedBy: "lawyer", typeConfidence: null }
      : await classify({ workspaceId, filename, pages, signal });
    const { card } = await read({ workspaceId, filename, pages, docType: t.docType, signal });
    return { ...card, ...t, edited: [] };
  },
};
