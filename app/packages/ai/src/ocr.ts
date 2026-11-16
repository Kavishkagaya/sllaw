// OCR with a vision model through the gateway (MODEL_OCR, default Gemini 3 Flash: the only one of 16 tried that read
// Sinhala and Tamil phone photos well, docs/APP.md 2026-11-16). A model call like any other: model("ocr", ...),
// metered for the step's workspace as kind ocr, one page a call. It has the shape of extract's OcrProvider (ai
// imports nothing of ours but usage): a photo goes as its URL, a scanned PDF page by page as its images.
import { usageScope } from "@sllaw/usage";
import { type FilePart, generateText } from "ai";
import { model, taskModel } from "./models";

const PROMPT = `Transcribe all the text in this page exactly as written, in its own language and script (English, \
Sinhala or Tamil), line by line, including headings, page numbers, stamps and handwriting. Do not translate, \
correct, complete, summarise or add anything. Where a word cannot be read, write [illegible] instead of guessing. \
Output only the text.`;

async function page(images: FilePart[], signal?: AbortSignal) {
  const r = await generateText({
    model: model("ocr", usageScope()?.workspaceId ?? "unknown", { pages: 1 }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: images.length > 1 ? `${PROMPT} The images are one page, top to bottom.` : PROMPT },
          ...images,
        ],
      },
    ],
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
    abortSignal: signal,
  });
  return r.text.trim();
}

export const gatewayOcr = () => ({
  by: `gateway:${taskModel("ocr")}@1`,
  /** A photo or scan of one page, read from its URL. */
  async ocr(file: { url: string; mime: string }, signal?: AbortSignal): Promise<string[]> {
    if (!file.mime.startsWith("image/"))
      throw Object.assign(new Error(`ocr: ${file.mime} is read page by page, not whole`), { retryable: false });
    return [await page([{ type: "file", data: new URL(file.url), mediaType: file.mime }], signal)];
  },
  /** One page of a scanned PDF from its images (PNG). */
  ocrPage: (images: Uint8Array[], signal?: AbortSignal) =>
    page(
      images.map((data) => ({ type: "file", data, mediaType: "image/png" })),
      signal,
    ),
});
