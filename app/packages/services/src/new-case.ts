// A new case (docs/features/onboarding.json): the lawyer tells it (text in any language, dropped files), checks the
// card the draft fills, and "Looks right" makes the case. Before that nothing is a case: the dropped files are the
// lawyer's own, read (extract, categorize) but found by no one (no scopes) and not indexed. Making the case links
// them to it, puts them under its scope and indexes them, and fills the case page with the office operations the
// page and the agent use.
import { type Card, type Draft, type DraftFile, draftCase } from "@sllaw/ai";
import { adoptFile, type FileRow, fileById, insertCase, linkCaseFile } from "@sllaw/db";
import { type Op, today } from "@sllaw/office";
import { getJson } from "@sllaw/storage";
import { flushUsage, withUsage } from "@sllaw/usage";
import { appDeps, createUpload, type FileInput, keys, type Signed, startProcessing } from "./files";
import { checkDraftUpload, checkNewCaseFiles, checkSpend } from "./limits";
import { writeOffice } from "./office";

export { draftSchema } from "@sllaw/ai";
export type { Draft };

/** A file dropped for a new case, if it is this user's and in no case yet. */
async function draftFile(a: Signed, id: string) {
  const f = await fileById(id);
  const ok =
    f &&
    f.workspaceId === a.workspace.id &&
    f.ownerId === a.user.id &&
    f.uploadState === "stored" &&
    !f.scopes.length &&
    !f.indexState;
  return ok ? f : null;
}

/** Step 1 of a dropped file's upload: read and categorized, found by no one until its case is made. */
export async function addDraftFile(a: Signed, input: FileInput) {
  await checkDraftUpload(a, input.size);
  return createUpload({ workspaceId: a.workspace.id, userId: a.user.id }, input, {
    steps: ["extract", "categorize"],
    scopes: [],
  });
}

/** What the draft reads of a file: its details as the reader found them, or only its name before that. */
async function detailsOf(f: FileRow): Promise<DraftFile> {
  const card = f.categorizeState === "done" ? await getJson<Card>(appDeps().store, keys.card(f.id)) : null;
  if (!card) return { name: f.name };
  const { edited: _, typedBy: __, typeConfidence: ___, tags: ____, language: _____, ...rest } = card;
  return { name: f.name, ...rest };
}

/** The draft of the new case from the lawyer's text and their dropped files: one model call, metered for the user. */
export async function draftNewCase(a: Signed, input: { text: string; fileIds: string[] }) {
  const files = (await Promise.all(input.fileIds.map((id) => draftFile(a, id)))).filter((f) => !!f);
  if (!input.text.trim() && !files.length) throw new Error("Tell us about the case, or add a file.");
  await checkSpend(a.user);
  const scope = { workspaceId: a.workspace.id, userId: a.user.id, task: "case.draft" };
  try {
    const details = await Promise.all(files.map(detailsOf));
    return await withUsage(scope, () =>
      draftCase({ workspaceId: a.workspace.id, text: input.text, files: details, today: today() }),
    );
  } finally {
    await flushUsage();
  }
}

/** The card as the lawyer confirmed it: the draft's fields, edited. */
export type NewCase = Omit<Draft, "kind"> & { kind?: string };

/** The operations that fill a new case's page from its card: header, client and parties, the next date. */
export function newCaseOps(c: NewCase): Op[] {
  const ops: Op[] = [];
  const set = {
    court: c.court.trim(),
    caseNumber: c.caseNumber.trim(),
    kind: (c.kind ?? "").trim(),
    side: c.side,
    stage: c.stage,
    client: c.client.trim(),
  };
  const header = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== ""));
  if (Object.keys(header).length) ops.push({ op: "header.set", set: header });
  if (set.client) ops.push({ op: "person.add", person: { name: set.client, role: "client" } });
  for (const p of c.parties)
    if (p.name.trim()) ops.push({ op: "person.add", person: { name: p.name.trim(), role: p.role } });
  if (c.nextDate)
    ops.push({ op: "date.add", date: c.nextDate.date, court: set.court, purpose: c.nextDate.purpose.trim() });
  return ops;
}

/** The case's facts: what the lawyer wrote, as written, and the facts still missing with why each matters. */
export function newCaseFacts(text: string, missing: Draft["missing"]) {
  const list = missing
    .filter((m) => m.fact.trim())
    .map((m) => `- ${m.fact.trim()}${m.why.trim() ? ` (${m.why.trim()})` : ""}`);
  return [text.trim(), list.length ? `Still to find out:\n${list.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/** "Looks right": makes the case with its files and fills its page. Returns its id. */
export async function startNewCase(a: Signed, input: { text: string; fileIds: string[]; card: NewCase }) {
  const files = (await Promise.all(input.fileIds.map((id) => draftFile(a, id)))).filter((f) => !!f);
  await checkNewCaseFiles(a, files.length);
  if (files.length) await checkSpend(a.user); // indexing them is model work (embedding)
  const { card } = input;
  const c = await insertCase({
    workspaceId: a.workspace.id,
    createdBy: a.user.id,
    title: card.title.trim() || "New case",
    facts: newCaseFacts(input.text, card.missing),
  });
  for (const f of files) {
    // adopted first: a file another case took meanwhile (two clicks at once) is not linked twice
    const adopted = await adoptFile(f.id, [`case:${c.id}`]);
    if (!adopted) continue;
    await linkCaseFile(c.id, f.id, a.user.id);
    if (adopted.extractState === "done") await startProcessing(f.id);
  }
  const ops = newCaseOps(card);
  if (ops.length) await writeOffice(c.id, ops, { by: "lawyer", userId: a.user.id, summary: "Case set up" });
  return { id: c.id };
}
