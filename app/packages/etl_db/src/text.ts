// Chunk text, read from the ETL's R2 bucket (decision 2026-11-07: no text in the database). A text part is
// {doc, chunks: [{id (uuid), text, ...}]} under a content-hash name, so it never changes: parts are cached in memory.
// Env: R2_ACCOUNT_ID, R2_LAW_BUCKET (default sllaw), and a read-only key for that bucket: R2_LAW_ACCESS_KEY_ID +
// R2_LAW_SECRET_ACCESS_KEY (storage's R2_ACCESS_KEY_ID is scoped to sllaw-files and gets 403 here, 2026-11-08).
import { AwsClient } from "aws4fetch";

let aws: AwsClient | null = null;
const MAX = 300; // parts kept (~256 KB each)
const cache = new Map<string, Promise<Map<string, string>>>();

function client() {
  const id = process.env.R2_LAW_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_LAW_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  if (!id || !secret || !process.env.R2_ACCOUNT_ID) throw new Error("etl_db: R2_LAW_* env not set");
  aws ??= new AwsClient({
    accessKeyId: id,
    secretAccessKey: secret,
    service: "s3",
    region: "auto",
  });
  return aws;
}

async function load(key: string) {
  const bucket = process.env.R2_LAW_BUCKET || "sllaw";
  const url = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const r = await client().fetch(url);
  if (!r.ok) throw new Error(`etl_db: text part ${key}: r2 ${r.status}`);
  const part = (await r.json()) as { chunks: { id: string; text: string }[] };
  return new Map(part.chunks.map((c) => [c.id, c.text]));
}

/** uuid -> text for the chunks of one text part. */
export function partTexts(key: string) {
  let p = cache.get(key);
  if (p) {
    cache.delete(key); // most recent last
  } else {
    p = load(key);
    p.catch(() => cache.delete(key));
  }
  cache.set(key, p);
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return p;
}
