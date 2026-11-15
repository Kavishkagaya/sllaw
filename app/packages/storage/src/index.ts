// The blob store: R2 (memoryStore is a fake for unit tests only). Switching storage is a change in this package alone.
import { r2Store } from "./r2";
import type { BlobStore } from "./store";

let store: BlobStore | null = null;
/** The app's store, made on first use (env is read then, not at import). */
export function blobStore(): BlobStore {
  return (store ??= r2Store());
}

export { memoryStore } from "./memory";
export { r2Store } from "./r2";
export { type Blob, type BlobStore, getJson, type Head, putJson } from "./store";
