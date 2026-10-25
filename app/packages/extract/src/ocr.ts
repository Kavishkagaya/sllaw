// OCR for scans: an OCR endpoint gets a signed URL to the whole file, fetches it itself and returns its text page by
// page as JSON. We send no bytes and split nothing. The provider is swapped by passing another one; its `by` goes
// into extract_by, so files read by the old one can be found and read again.
import { ext, NoText, type Extractor, type ExtractCtx } from "./extractor";
import { pdfPagesText } from "./pdf";

export interface OcrProvider {
  readonly by: string; // name@version
  /** Every page's text, in order (page 1 first), of the file at `url`. */
  ocr(file: { url: string; mime: string; filename: string }): Promise<string[]>;
}

/** Any OCR service with this contract:
 *    POST <OCR_URL>   Authorization: Bearer <OCR_TOKEN>
 *    { "url": "<signed GET url>", "mime": "application/pdf", "filename": "plaint.pdf" }
 *  -> { "pages": [{ "n": 1, "text": "..." }, ...] }   (or "pages": ["...", ...])  */
export function httpOcr(env = process.env): OcrProvider | null {
  const { OCR_URL, OCR_TOKEN, OCR_NAME = "http" } = env;
  if (!OCR_URL) return null;
  const TIMEOUT = Number(env.OCR_TIMEOUT_MS || 240_000);
  return {
    by: `${OCR_NAME}@1`,
    async ocr(file) {
      const r = await fetch(OCR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(OCR_TOKEN && { Authorization: `Bearer ${OCR_TOKEN}` }) },
        body: JSON.stringify(file),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) throw new Error(`ocr ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const { pages } = (await r.json()) as { pages: (string | { n: number; text: string })[] };
      if (!Array.isArray(pages)) throw new Error("ocr: no pages in the response");
      return pages
        .map((p, i) => (typeof p === "string" ? { n: i + 1, text: p } : p))
        .sort((a, b) => a.n - b.n)
        .map((p) => p.text ?? "");
    },
  };
}

const url = async (ctx: ExtractCtx | undefined) => {
  const u = await ctx?.url?.();
  if (!u) throw new Error("ocr: the store gives no URL to fetch the file from");
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
      const ocr = await provider.ocr({ url: await url(ctx), mime, filename });
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
      const pages = (await provider.ocr({ url: await url(ctx), mime, filename })).map((t, i) => ({ n: i + 1, text: t.trim() }));
      if (!pages.some((p) => p.text)) throw new NoText("needs_ocr", "OCR found no text");
      return pages;
    },
  };
}
