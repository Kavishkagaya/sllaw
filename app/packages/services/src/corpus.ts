import { coverageCounts, docInfo, docWithChunks } from "@sllaw/etl_db";
import { asOf } from "./agent";

export const getDoc = (key: string) => docWithChunks(key);

/** A cited chunk for the viewer: its text and changes as of a date, and its law with the source link. */
export async function getChunk(chunkId: number, date?: string) {
  const a = await asOf(chunkId, date);
  if (!a) return null;
  return { ...a, doc: await docInfo(a.chunk.docKey) };
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
