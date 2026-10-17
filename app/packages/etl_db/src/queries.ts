import { asc, eq } from "drizzle-orm";
import { db } from "./index";
import { chunks, docs } from "./schema";

export async function docWithChunks(key: string) {
  const [doc] = await db.select().from(docs).where(eq(docs.key, key));
  if (!doc) return null;
  const parts = await db
    .select({ id: chunks.id, seq: chunks.seq, label: chunks.label, path: chunks.path, text: chunks.text })
    .from(chunks)
    .where(eq(chunks.docKey, key))
    .orderBy(asc(chunks.seq));
  return { ...doc, chunks: parts };
}
