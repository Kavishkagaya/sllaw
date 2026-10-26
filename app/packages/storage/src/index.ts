// The blob store, picked by STORAGE (r2 | memory; default r2). Switching storage is a change in this package alone.
import { memoryStore } from "./memory";
import { r2Store } from "./r2";
import type { BlobStore } from "./store";

let store: BlobStore | null = null;
/** The app's store, made on first use (env is read then, not at import). */
export function blobStore(): BlobStore {
  return (store ??= process.env.STORAGE === "memory" ? memoryStore() : r2Store());
}

export { memoryStore } from "./memory";
export { r2Store } from "./r2";
export { getJson, putJson, type Blob, type BlobStore, type Head } from "./store";
