// In-process store: tests and local runs without R2. Lost on restart.
import type { BlobStore } from "./store";

export function memoryStore(): BlobStore & { keys(): string[] } {
  const m = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  return {
    name: "memory",
    keys: () => [...m.keys()].sort(),
    async put(key, bytes, contentType) {
      m.set(key, { bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, contentType: contentType ?? null });
    },
    async get(key) {
      return m.get(key) ?? null;
    },
    async head(key) {
      const b = m.get(key);
      return b ? { size: b.bytes.byteLength, contentType: b.contentType } : null;
    },
    async deletePrefix(prefix) {
      const ks = [...m.keys()].filter((k) => k.startsWith(prefix));
      ks.forEach((k) => m.delete(k));
      return ks.length;
    },
    uploadUrl: async () => null,
    downloadUrl: async () => null,
  };
}
