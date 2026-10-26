// Word .docx via mammoth (raw text: paragraphs, no styles). .doc (binary Word) is not read.
import mammoth from "mammoth";
import { ext, NoText, type Extractor } from "./extractor";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const docxExtractor: Extractor = {
  name: "mammoth",
  version: 1,
  accepts: (mime, filename) => mime === DOCX || ext(filename) === "docx",
  async extract(bytes) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = value.replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new NoText("needs_ocr", "no text in the document (images only?)");
    return [{ n: 1, text }];
  },
};
