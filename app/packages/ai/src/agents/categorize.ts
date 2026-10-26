// Categorizing a file (docs/APP.md, File ingestion): one cheap-model read of its text returning a card: what the
// document is, who and what it is about. Not research: no tools, one call. The card is metadata on the file's row,
// except the summary, which is content and goes to the blob store with the text.
import { generateText, Output } from "ai";
import { z } from "zod";
import { model } from "../models";

export const DOC_TYPES = [
  "plaint", "answer", "replication", "petition", "objections", "affidavit", "counter_affidavit", "motion",
  "written_submissions", "appeal", "judgment", "order", "decree", "journal_entry", "indictment", "charge_sheet",
  "statement", "evidence", "expert_report", "medical_report", "police_report", "contract", "agreement", "lease",
  "deed", "will", "power_of_attorney", "letter", "notice", "letter_of_demand", "email", "invoice", "receipt",
  "identity_document", "certificate", "gazette", "legislation", "form", "notes", "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

const card = z.object({
  docType: z.enum(DOC_TYPES).describe("what kind of document this is; 'other' when none fits"),
  title: z.string().describe("a short title a lawyer would give it, e.g. 'Plaint, DC Colombo 12345/L'"),
  language: z.enum(["en", "si", "ta", "mixed"]),
  summary: z.string().describe("3-6 sentences in English: what it is, who files or writes it, what it asks or says"),
  parties: z.array(z.object({ name: z.string(), role: z.string().describe("plaintiff, defendant, petitioner, respondent, accused, witness, lessor ...") })),
  dates: z.array(z.object({ date: z.string().describe("YYYY-MM-DD, or YYYY-MM / YYYY when that is all it gives"), what: z.string() })),
  court: z.string().nullable().describe("the court or tribunal, as written; null if none"),
  caseNumbers: z.array(z.string()).describe("case numbers as written, e.g. 'DC Colombo 12345/L', 'SC Appeal 21/2019'"),
  lawsCited: z.array(z.string()).describe("statutes and sections cited, as written, e.g. 's. 46 of the Civil Procedure Code'"),
  tags: z.array(z.string()).describe("up to 6 short subject tags: 'rent', 'land', 'partition', 'bail' ..."),
});
export type Card = z.infer<typeof card>;

/** Reads a file's text and returns its card. `by` is name@version, recorded on the file row (categorize_by). */
export interface Categorizer {
  readonly by: string;
  /** Stops when `signal` aborts (the step's time is up). */
  categorize(input: { workspaceId: string; filename: string; text: string; signal?: AbortSignal }): Promise<Card>;
}

const HEAD = 24_000; // chars read from the start and the end: enough to tell what a document is, at a few cents per 1k files
const TAIL = 4_000;
const VERSION = 1; // bump when the prompt or the card changes: files categorized before can then be found and redone

const instructions = `You read one document from a Sri Lankan lawyer's case file and describe it as JSON. Take
everything from the document itself; never guess a party, date or case number it does not give. The document may be
in English, Sinhala or Tamil; write the summary in English and keep names, case numbers and citations as written.`;

export const llmCategorizer: Categorizer = {
  by: `llm:${process.env.MODEL_FILES || "default"}@${VERSION}`,
  async categorize({ workspaceId, filename, text, signal }) {
    const body = text.length <= HEAD + TAIL ? text : `${text.slice(0, HEAD)}\n\n[… ${text.length - HEAD - TAIL} characters left out …]\n\n${text.slice(-TAIL)}`;
    const { output } = await generateText({
      model: model("files", workspaceId),
      system: instructions,
      prompt: `File name: ${filename}\n\n<document>\n${body}\n</document>`,
      output: Output.object({ schema: card, name: "card" }),
      abortSignal: signal,
    });
    return output;
  },
};
