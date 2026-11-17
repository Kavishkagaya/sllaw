import {
  amendsOf,
  changedBy,
  chunksById,
  citedBy,
  coverageCounts,
  docInfo,
  docSource,
  docWithChunks,
  isJudgment,
  lawChanges,
} from "@sllaw/etl_db";
import { asChunk, asOf } from "./agent";

export const getDoc = (key: string) => docWithChunks(key);
/** The stored PDF or HTML a law was built from, signed for 15 minutes (the viewer beside its text). */
export const getDocSource = (key: string) => docSource(key);

/** A cited chunk for the source panel and the Sources list (light: no clauses): its text, its law, which laws changed
 *  it, what it amends when it is an amending section, and the timeline of the law where it matters (the amended law
 *  for an amending section). The clauses are the history page's (getHistory). null when the id is gone. */
export async function getChunk(chunkId: number) {
  const [c] = await chunksById([chunkId]);
  if (!c) return null;
  // a judgment has no history: its details and its court's PDF only
  if (isJudgment(c.docKey))
    return { chunk: asChunk(c), doc: await docInfo(c.docKey), changed: [], amends: null, timeline: [], judgment: true };
  // two round trips: the chunk, then everything else side by side (an amending section adds its target law's timeline)
  const [doc, changed, amends, own] = await Promise.all([
    docInfo(c.docKey),
    changedBy(chunkId),
    amendsOf(c.docKey, chunkId),
    lawChanges(c.docKey),
  ]);
  return {
    chunk: asChunk(c),
    doc,
    changed,
    amends,
    timeline: amends ? await lawChanges(amends.docKey) : own,
    judgment: false,
  };
}

/** The judgments that cite a section, newest first: the first `limit` and the total (the panel shows 10, then all). */
export const getCitedBy = (chunkId: number, limit?: number) => citedBy(chunkId, limit);

/** A section's full history (the /history page only): the section as enacted, every change made to it up to today,
 *  oldest first, each with the amending section's whole text (not the clipped clause the agent gets), the changes
 *  after today named, and the law's timeline. null when the id is gone. */
export async function getHistory(chunkId: number) {
  const a = await asOf(chunkId);
  if (!a) return null;
  const ids = a.changes.flatMap((c) => (c.byChunk != null ? [c.byChunk] : []));
  const [doc, timeline, amending] = await Promise.all([
    docInfo(a.chunk.docKey),
    lawChanges(a.chunk.docKey),
    chunksById(ids),
  ]);
  const full = new Map(amending.map((c) => [c.id, c.text]));
  return {
    ...a,
    doc,
    timeline,
    changes: a.changes.map((c) => ({ ...c, text: (c.byChunk != null && full.get(c.byChunk)) || c.clause })),
  };
}

// The public Coverage page's counts change once a day (the pipeline runs at 02:00 Colombo): one query an hour per
// server instance, kept in memory.
let covered: { at: number; value: Promise<Awaited<ReturnType<typeof coverageCounts>>> } | null = null;
export function coverage(now = Date.now()) {
  if (!covered || now - covered.at > 3_600_000) {
    const value = coverageCounts();
    covered = { at: now, value };
    value.catch(() => {
      covered = null; // a failed query is not kept
    });
  }
  return covered.value;
}
