// Editing a file's card (docs/features/file-types.json): the lawyer on the file page, or the agent when the lawyer
// asks. Any field and the type; a new type re-reads the file for that type's fields and keeps what was typed.
// No history and no undo (user, 2026-11-11).
import { type Card, type DocType, FIELDS, type FieldValue } from "@sllaw/ai";
import { claimReread, endReread, type FileRow, setFileCard } from "@sllaw/db";
import { getJson, putJson } from "@sllaw/storage";
import { flushUsage, withUsage } from "@sllaw/usage";
import { checkSpend } from "../limits";
import { appDeps } from "./deps";
import { type Deps, keys } from "./pipeline";

/** What an edit may change: the generic card's fields, the type, and the type's own fields. */
export type CardPatch = Partial<Omit<Card, "docType" | "fields" | "typedBy" | "typeConfidence" | "edited">> & {
  docType?: DocType;
  fields?: Record<string, FieldValue>;
};

const GENERIC = [
  "title",
  "language",
  "summary",
  "parties",
  "dates",
  "court",
  "caseNumbers",
  "lawsCited",
  "tags",
] as const;
const fieldKey = (k: string) => `fields.${k}`;

/** The card after the patch: changed keys join `edited` (generic names, and `fields.<key>`); a field the type does
 *  not have is dropped. */
export function applyPatch(card: Card, patch: CardPatch): Card {
  const next: Card = { ...card, fields: { ...(card.fields ?? {}) }, edited: [...(card.edited ?? [])] };
  const mark = (k: string) => next.edited.includes(k) || next.edited.push(k);
  for (const k of GENERIC) {
    if (patch[k] === undefined) continue;
    (next as Record<string, unknown>)[k] = patch[k];
    mark(k);
  }
  const allowed = new Set((FIELDS[next.docType] ?? []).map((s) => s.key));
  for (const [k, v] of Object.entries(patch.fields ?? {})) {
    if (!allowed.has(k)) continue;
    next.fields[k] = v;
    mark(fieldKey(k));
  }
  return next;
}

/** A re-read for a new type keeps what was typed: the edited generic fields, and edited fields the new type has. */
export function keepEdited(old: Card, fresh: Card): Card {
  const next: Card = { ...fresh, edited: [] };
  for (const k of old.edited ?? []) {
    if (k.startsWith("fields.")) {
      const f = k.slice(7);
      if (f in fresh.fields && f in (old.fields ?? {})) {
        next.fields[f] = old.fields[f];
        next.edited.push(k);
      }
    } else if ((GENERIC as readonly string[]).includes(k)) {
      (next as Record<string, unknown>)[k] = old[k as (typeof GENERIC)[number]];
      next.edited.push(k);
    }
  }
  return next;
}

/** A re-read is already running for the file. */
export class FileBusy extends Error {
  constructor() {
    super("This file is being read: try again in a minute.");
  }
}

/** Edits a file's card and returns it; null when it has no card yet (still being read, or no text). `user` is who
 *  a new type's re-read is checked and metered for. */
export async function editCard(
  f: FileRow,
  patch: CardPatch,
  user: { id: string; isAdmin?: boolean } | null,
  d: Deps = appDeps(),
) {
  const userId = user?.id ?? null;
  if (f.categorizeState !== "done") return null;
  const card = await getJson<Card>(d.store, keys.card(f.id));
  if (!card) return null;
  let next = card;
  if (patch.docType && patch.docType !== card.docType) {
    const x = await getJson<{ pages: { n: number; text: string }[] }>(d.store, keys.extract(f.id));
    if (!x) return null;
    if (user) await checkSpend(user); // a re-read is model work: the user's spend
    if (!(await claimReread(f.id))) throw new FileBusy();
    try {
      const fresh = await withUsage(
        { workspaceId: f.workspaceId, userId, task: "file.retype", ref: `file:${f.id}` },
        () =>
          d.categorizer.categorize({
            workspaceId: f.workspaceId,
            filename: f.name,
            pages: x.pages.map((p) => ({ page: p.n, text: p.text })),
            docType: patch.docType,
          }),
      );
      next = keepEdited(card, fresh);
    } finally {
      await flushUsage();
      await endReread(f.id);
    }
  }
  next = applyPatch(next, { ...patch, docType: undefined });
  await putJson(d.store, keys.card(f.id), next);
  const { summary: _, docType, ...meta } = next;
  await setFileCard(f.id, docType, meta);
  return next;
}
