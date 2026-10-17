// Reading the law corpus. Plain functions: the tRPC routers (api) and the agents' tools (ai) both call these.
import { asc, chunks, db, docs, eq } from "@sllaw/db";

export async function getDoc(key: string) {
  const [doc] = await db.select().from(docs).where(eq(docs.key, key));
  if (!doc) return null;
  const parts = await db
    .select({ id: chunks.id, seq: chunks.seq, label: chunks.label, path: chunks.path, text: chunks.text })
    .from(chunks)
    .where(eq(chunks.docKey, key))
    .orderBy(asc(chunks.seq));
  return { ...doc, chunks: parts };
}
