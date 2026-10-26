// Plain text formats, read as UTF-8; HTML with its tags stripped.
import { ext, NoText, type Extractor } from "./extractor";

const TEXT = new Set(["txt", "md", "markdown", "csv", "json", "eml", "html", "htm"]);

export const textExtractor: Extractor = {
  name: "text",
  version: 1,
  accepts: (mime, filename) => mime.startsWith("text/") || mime === "application/json" || TEXT.has(ext(filename)),
  async extract(bytes, mime, filename) {
    let t = new TextDecoder("utf-8").decode(bytes);
    if (mime === "text/html" || ["html", "htm"].includes(ext(filename))) t = stripHtml(t);
    t = t.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) throw new NoText("needs_ocr", "empty file");
    return [{ n: 1, text: t }];
  },
};

const stripHtml = (h: string) =>
  h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
