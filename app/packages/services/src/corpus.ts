import { docInfo, docWithChunks } from "@sllaw/etl_db";
import { asOf } from "./agent";

export const getDoc = (key: string) => docWithChunks(key);

/** A cited chunk for the viewer: its text and changes as of a date, and its law with the source link. */
export async function getChunk(chunkId: number, date?: string) {
  const a = await asOf(chunkId, date);
  if (!a) return null;
  return { ...a, doc: await docInfo(a.chunk.docKey) };
}
