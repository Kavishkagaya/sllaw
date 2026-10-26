// The blob store: where every uploaded file and everything derived from it lives (docs/APP.md, Files). Postgres keeps
// only a file's row (state and metadata); content is here. A new store implements BlobStore and nothing else changes.
export type Blob = { bytes: Uint8Array; contentType: string | null };
export type Head = { size: number; contentType: string | null };

export interface BlobStore {
  /** "r2", "memory": recorded nowhere, for logs. */
  readonly name: string;
  put(key: string, bytes: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  head(key: string): Promise<Head | null>;
  /** Removes every key under a prefix (a file's folder). */
  deletePrefix(prefix: string): Promise<number>;
  /** A URL the browser PUTs the file to directly (Vercel caps request bodies at 4.5 MB). null when the store has
   *  none (memory): the client then sends the bytes through the app. */
  uploadUrl(key: string, contentType: string, expiresIn: number): Promise<string | null>;
  /** A URL to read the file for a while (download, preview). */
  downloadUrl(key: string, expiresIn: number, filename?: string): Promise<string | null>;
}

export async function getJson<T>(s: BlobStore, key: string): Promise<T | null> {
  const b = await s.get(key);
  return b ? (JSON.parse(new TextDecoder().decode(b.bytes)) as T) : null;
}

export const putJson = (s: BlobStore, key: string, value: unknown) =>
  s.put(key, JSON.stringify(value), "application/json");
