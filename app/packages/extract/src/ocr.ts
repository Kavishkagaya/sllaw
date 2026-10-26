// OCR for scans: an OCR endpoint gets a signed URL to the whole file, fetches it itself and returns its text page by
// page as JSON. We send no bytes and split nothing. The provider is swapped by passing another one; its `by` goes
// into extract_by, so files read by the old one can be found and read again.
import { type ExtractCtx, type Extractor, ext, NoText } from "./extractor";
import { pdfPagesText } from "./pdf";

export interface OcrProvider {
  readonly by: string; // name@version
  /** Every page's text, in order (page 1 first), of the file at `url`. Stops when `signal` aborts. */
  ocr(file: { url: string; mime: string; filename: string }, signal?: AbortSignal): Promise<string[]>;
}

/** Any OCR service with this contract:
 *    POST <OCR_URL>   Authorization: Bearer <OCR_TOKEN>
 *    { "url": "<signed GET url>", "mime": "application/pdf", "filename": "plaint.pdf" }
 *  -> { "pages": [{ "n": 1, "text": "..." }, ...] }   (or "pages": ["...", ...])  */
export function httpOcr(env = process.env): OcrProvider | null {
  const { OCR_URL, OCR_TOKEN, OCR_NAME = "http" } = env;
  if (!OCR_URL) return null;
  const timeout = Number(env.OCR_TIMEOUT_MS || 240_000);
  return {
    by: `${OCR_NAME}@1`,
    async ocr(file, signal) {
      const { pages } = (await postJson(OCR_URL, OCR_TOKEN, file, timeout, "ocr", signal)) as {
        pages?: (string | { n: number; text: string })[];
      };
      if (!Array.isArray(pages)) throw Object.assign(new Error("ocr: no pages in the response"), { retryable: true });
      return pages
        .map((p, i) => (typeof p === "string" ? { n: i + 1, text: p } : p))
        .sort((a, b) => a.n - b.n)
        .map((p) => p.text ?? "");
    },
  };
}

/** Mistral OCR (POST /v1/ocr): it fetches the signed URL itself and returns markdown per page. Off until
 *  OCR_PROVIDER=mistral (ocrFromEnv); then MISTRAL_API_KEY is required. MISTRAL_OCR_MODEL pins a model, e.g.
 *  mistral-ocr-2512 (default the -latest alias: pin one before production, so extract_by names what read the file). */
export function mistralOcr(env = process.env): OcrProvider {
  const key = env.MISTRAL_API_KEY;
  if (!key) throw new Error("ocr: OCR_PROVIDER=mistral needs MISTRAL_API_KEY");
  const model = env.MISTRAL_OCR_MODEL || "mistral-ocr-latest";
  const timeout = Number(env.OCR_TIMEOUT_MS || 240_000);
  return {
    by: `mistral:${model}@1`,
    async ocr({ url, mime }, signal) {
      const document = mime.startsWith("image/")
        ? { type: "image_url", image_url: url }
        : { type: "document_url", document_url: url };
      const { pages } = (await postJson(
        "https://api.mistral.ai/v1/ocr",
        key,
        { model, document },
        timeout,
        "mistral ocr",
        signal,
      )) as {
        pages?: { index: number; markdown?: string }[];
      };
      if (!Array.isArray(pages))
        throw Object.assign(new Error("mistral ocr: no pages in the response"), { retryable: true });
      return pages
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((p) => (p.markdown ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim()); // image placeholders: no text
    },
  };
}

/** The OCR provider the app runs with: OCR_PROVIDER=mistral, else the generic endpoint when OCR_URL is set, else none
 *  (a scan is then no_text). */
export const ocrFromEnv = (env = process.env): OcrProvider | null =>
  env.OCR_PROVIDER === "mistral" ? mistralOcr(env) : httpOcr(env);

/** POST JSON, the parsed answer. A network error or a timeout is worth another try; an HTTP error carries its status
 *  (services/files/errors.ts decides). Stops at `timeout` or when the step's `signal` aborts, whichever is first;
 *  the step's own abort is passed up as it is (the step names its timeout). */
async function postJson(
  endpoint: string,
  token: string | undefined,
  body: unknown,
  timeout: number,
  what: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  }).catch((e: Error) => {
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new Error(`${what}: ${e.message}`), { retryable: true });
  });
  if (!r.ok)
    throw Object.assign(new Error(`${what} ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
  return r.json().catch(() => ({}));
}

const url = async (ctx: ExtractCtx | undefined) => {
  const u = await ctx?.url?.();
  if (!u) throw Object.assign(new Error("ocr: the store gives no URL to fetch the file from"), { retryable: false });
  return u;
};

/** Text-layer PDFs read here; when any page has no text layer, the whole file goes to OCR and those pages take its
 *  text (pages with a text layer keep theirs: it is exact). */
export function ocrPdfExtractor(provider: OcrProvider): Extractor {
  return {
    name: `unpdf+ocr:${provider.by}`,
    version: 1,
    accepts: (mime, filename) => mime === "application/pdf" || ext(filename) === "pdf",
    async extract(bytes, mime, filename, ctx) {
      const { pages, empty } = await pdfPagesText(bytes);
      if (!empty.length) return pages;
      const ocr = await provider.ocr({ url: await url(ctx), mime, filename }, ctx?.signal);
      const missing = new Set(empty);
      const merged = pages.map((p) => (missing.has(p.n) ? { n: p.n, text: (ocr[p.n - 1] ?? "").trim() } : p));
      if (!merged.some((p) => p.text)) throw new NoText("needs_ocr", "OCR found no text");
      return merged;
    },
  };
}

const IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "heic"]);

/** A photo or scan of pages (an image; a multi-page TIFF gives several). */
export function ocrImageExtractor(provider: OcrProvider): Extractor {
  return {
    name: `ocr:${provider.by}`,
    version: 1,
    accepts: (mime, filename) => mime.startsWith("image/") || IMAGES.has(ext(filename)),
    async extract(_bytes, mime, filename, ctx) {
      const pages = (await provider.ocr({ url: await url(ctx), mime, filename }, ctx?.signal)).map((t, i) => ({
        n: i + 1,
        text: t.trim(),
      }));
      if (!pages.some((p) => p.text)) throw new NoText("needs_ocr", "OCR found no text");
      return pages;
    },
  };
}
