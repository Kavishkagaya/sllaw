// Every LLM call goes through Vercel AI Gateway (AI_GATEWAY_API_KEY locally, OIDC on Vercel): one key for every
// provider, spend per workspace (`user`), fallbacks. The model per task is config, picked later (docs/APP.md): set
// MODEL_<TASK> ("provider/model", as the gateway names it) to change one without touching code.
import { gateway, wrapLanguageModel } from "ai";

const tasks = {
  main: process.env.MODEL_MAIN || "deepseek/deepseek-v4.1-flash",
  files: process.env.MODEL_FILES || "deepseek/deepseek-v4.1-flash",
  // must read PDFs and images (DeepSeek does not); not compared yet on Sinhala/Tamil scans
  ocr: process.env.MODEL_OCR || "google/gemini-2.5-flash",
};
export const ocrModelId = tasks.ocr;
export type Task = keyof typeof tasks;

// Pinned providers, in order: each keeps its own prompt cache, and the gateway spread calls over ~20 hosts. The
// endpoint list prices are not what is billed (deepseek billed 2x its list): picked on the 9-question eval
// (PIPELINE.md, 2026-10-20). deepinfra $0.017, median 21 s; deepseek $0.094, 36 s, kept as the fallback.
const PROVIDERS = process.env.MODEL_PROVIDERS?.split(",") ?? ["deepinfra", "deepseek"];

export type Call = {
  workspaceId: string;
  task: Task;
  input: number; // all input tokens
  cached: number; // of which read from the provider's cache
  output: number;
  gateway: unknown; // providerMetadata.gateway as returned (cost, generation id, routing)
};
let recorder: ((c: Call) => void) | null = null;
/** Sees every non-streamed call (agents' generate); evals use it to count usage. The chat (streamed) sums its own
 *  per message: streamChat's Usage. */
export const recordCalls = (f: ((c: Call) => void) | null) => void (recorder = f);

/** The model for a task; each call is attributed to the workspace (spend per workspace sets pricing). */
export function model(task: Task, workspaceId: string) {
  return wrapLanguageModel({
    model: gateway(tasks[task]),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          gateway: {
            ...params.providerOptions?.gateway,
            user: workspaceId,
            tags: [`task:${task}`],
            ...(tasks[task].startsWith("deepseek/") && { order: PROVIDERS, only: PROVIDERS }),
          },
        },
      }),
      wrapGenerate: async ({ doGenerate }) => {
        const r = await doGenerate();
        recorder?.({
          workspaceId,
          task,
          input: r.usage.inputTokens.total ?? 0,
          cached: r.usage.inputTokens.cacheRead ?? 0,
          output: r.usage.outputTokens.total ?? 0,
          gateway: r.providerMetadata?.gateway,
        });
        return r;
      },
    },
  });
}
