// Cloudflare R2 over its S3 API, signed with aws4fetch (small, fetch-based: fine on Vercel functions).
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_FILES_BUCKET. Browser uploads need a CORS rule on the
// bucket allowing PUT from the app's origin.
import { AwsClient } from "aws4fetch";
import type { BlobStore } from "./store";

export function r2Store(env = process.env): BlobStore {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_FILES_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_FILES_BUCKET)
    throw new Error("r2: R2_* env not set");
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const base = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_FILES_BUCKET}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function ok(r: Response, what: string) {
    if (!r.ok)
      throw Object.assign(new Error(`r2 ${what} ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
    return r;
  }
  const signed = async (u: string, method: string, expiresIn: number, headers: Record<string, string> = {}) => {
    const q = new URL(u);
    q.searchParams.set("X-Amz-Expires", String(expiresIn));
    return (await aws.sign(q.toString(), { method, headers, aws: { signQuery: true } })).url;
  };

  return {
    name: "r2",
    async put(key, bytes, contentType = "application/octet-stream") {
      await ok(
        await aws.fetch(url(key), { method: "PUT", body: bytes as BodyInit, headers: { "Content-Type": contentType } }),
        `put ${key}`,
      );
    },
    async get(key) {
      const r = await aws.fetch(url(key));
      if (r.status === 404) return null;
      await ok(r, `get ${key}`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") };
    },
    async head(key) {
      // identity: R2 gzips text types (text/plain, json, html) for a client that accepts it, and a gzipped answer has
      // no content-length: the size read 0 and the upload size check let any text file through (2026-10-26)
      const r = await aws.fetch(url(key), { method: "HEAD", headers: { "Accept-Encoding": "identity" } });
      if (r.status === 404) return null;
      await ok(r, `head ${key}`);
      const len = r.headers.get("content-length");
      if (len == null) throw new Error(`r2 head ${key}: no content-length`);
      return { size: Number(len), contentType: r.headers.get("content-type") };
    },
    async deletePrefix(prefix) {
      let n = 0;
      for (;;) {
        const r = await ok(
          await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`),
          `list ${prefix}`,
        );
        const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => unxml(m[1]!));
        if (!keys.length) return n;
        for (const k of keys) await ok(await aws.fetch(url(k), { method: "DELETE" }), `delete ${k}`);
        n += keys.length;
      }
    },
    uploadUrl: (key, contentType, expiresIn) => signed(url(key), "PUT", expiresIn, { "Content-Type": contentType }),
    async downloadUrl(key, expiresIn, filename) {
      const u = new URL(url(key));
      if (filename)
        u.searchParams.set(
          "response-content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
      return signed(u.toString(), "GET", expiresIn);
    },
  };
}

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
