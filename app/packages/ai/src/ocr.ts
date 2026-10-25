// OCR with a vision model through the AI Gateway: spend per workspace like every other call, no new key. Matches
// @sllaw/extract's OcrProvider (ai imports no package of ours; services joins the two). The model is MODEL_OCR;
// a dedicated OCR API (Mistral OCR ...) would be another provider with the same shape, in extract.
import { generateText, Output } from "ai";
import { z } from "zod";
import { model, ocrModelId } from "./models";

const VERSION = 1; // bump when the prompt changes

const instructions = `You transcribe scanned pages from Sri Lankan legal documents. Write out all the text on each
page exactly as it appears: Sinhala, Tamil and English in their own script, numbers, case numbers, dates, stamps and
handwriting you can read. Keep the reading order and paragraph breaks; render tables as rows of text. Do not
summarize, translate, correct or add anything. A page with no text is an empty string.`;

export const visionOcr = (workspaceId: string) => ({
  by: `vision:${ocrModelId}@${VERSION}`,
  async ocr(file: { bytes: Uint8Array; mime: string }, pageCount: number): Promise<string[]> {
    const { output } = await generateText({
      model: model("ocr", workspaceId),
      system: instructions,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: file.bytes, mediaType: file.mime },
            { type: "text", text: `This document has ${pageCount} page(s). Return one entry per page, in order.` },
          ],
        },
      ],
      output: Output.object({ schema: z.object({ pages: z.array(z.string()).length(pageCount) }), name: "pages" }),
    });
    return output.pages;
  },
});
