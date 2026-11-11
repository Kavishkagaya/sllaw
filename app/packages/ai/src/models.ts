// Every LLM call goes through Vercel AI Gateway (AI_GATEWAY_API_KEY locally, OIDC on Vercel): one key for every
// provider, spend per workspace (`user`), fallbacks. The model per task is config, picked later (docs/APP.md): set
// MODEL_<TASK> ("provider/model", as the gateway names it) to change one without touching code.
import { meter, type Scope, usageScope } from "@sllaw/usage";
import { gateway, type LanguageModelMiddleware, wrapLanguageModel } from "ai";

const tasks = {
  main: process.env.MODEL_MAIN || "deepseek/deepseek-v4.1-flash",
  files: process.env.MODEL_FILES || "deepseek/deepseek-v4.1-flash",
};
export type Task = keyof typeof tasks;

// Pinned providers, in order: each keeps its own prompt cache, and the gateway spread calls over ~20 hosts. The
// endpoint list prices are not what is billed (deepseek billed 2x its list): picked on the 9-question eval
// (PIPELINE.md, 2026-10-20). deepinfra $0.017, median 21 s; deepseek $0.094, 36 s, kept as the fallback.
const PROVIDERS = process.env.MODEL_PROVIDERS?.split(",") ?? ["deepinfra", "deepseek"];

// the provider's stream part and usage, as the middleware sees them (ai does not export their names)
type DoStream = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["doStream"];
type Part = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer P> ? P : never;
type ModelUsage = Extract<Part, { type: "finish" }>["usage"];
type GatewayMeta = { cost?: string; gatewayCost?: string; generationId?: string; routing?: { finalProvider?: string } };

/** One model call as a usage event: tokens, and what the gateway billed (gatewayCost; cost = the provider's part). */
function meterCall(task: Task, scope: Scope, modelId: string, usage: ModelUsage, meta: unknown) {
  const g = ((meta as { gateway?: GatewayMeta } | undefined)?.gateway ?? {}) as GatewayMeta;
  const billed = g.gatewayCost ?? g.cost;
  meter(
    {
      kind: "llm",
      task,
      model: modelId,
      quantity: {
        input: usage.inputTokens.total ?? 0,
        cached: usage.inputTokens.cacheRead ?? 0,
        output: usage.outputTokens.total ?? 0,
        reasoning: usage.outputTokens.reasoning ?? 0,
      },
      costUsd: billed == null ? null : Number(billed),
      idem: g.generationId ? `gateway:${g.generationId}` : null,
      meta: { provider: g.routing?.finalProvider ?? null, inferenceCost: g.cost == null ? null : Number(g.cost) },
    },
    scope,
  );
}

/** The decision model that names a file's type (MODEL_CLASSIFY): Jev, input billed, output free. A language model id
 *  here (e.g. "deepseek/...") makes the classifier ask that model instead. */
export const CLASSIFY_MODEL = process.env.MODEL_CLASSIFY || "typesafe-ai/jev-1.14.0";

/** Meters one decision call (no middleware for decision models): its input tokens and what the gateway billed. */
export function meterDecision(workspaceId: string, modelId: string, inputTokens: number | undefined, meta: unknown) {
  const g = ((meta as { gateway?: GatewayMeta } | undefined)?.gateway ?? {}) as GatewayMeta;
  const billed = g.gatewayCost ?? g.cost;
  meter(
    {
      kind: "llm",
      task: "classify",
      model: modelId,
      quantity: { input: inputTokens ?? 0, cached: 0, output: 0, reasoning: 0 },
      costUsd: billed == null ? null : Number(billed),
      idem: g.generationId ? `gateway:${g.generationId}` : null,
      meta: { provider: g.routing?.finalProvider ?? null, inferenceCost: g.cost == null ? null : Number(g.cost) },
    },
    usageScope() ?? { workspaceId },
  );
}

/** Meters every call, streamed (the chat: one per step) or not (categorize), for the usage scope the call started
 *  in (a stream's finish part may be read outside it), else for the workspace. A stream cut off before its finish
 *  part (the stop button) reports no usage, so that one step goes unmetered. */
export const meterMiddleware = (task: Task, workspaceId: string): LanguageModelMiddleware => ({
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, model }) => {
    const scope = usageScope() ?? { workspaceId };
    const r = await doGenerate();
    meterCall(task, scope, model.modelId, r.usage, r.providerMetadata);
    return r;
  },
  wrapStream: async ({ doStream, model }) => {
    const scope = usageScope() ?? { workspaceId };
    const r = await doStream();
    const stream = r.stream.pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, out) {
          if (part.type === "finish") meterCall(task, scope, model.modelId, part.usage, part.providerMetadata);
          out.enqueue(part);
        },
      }),
    );
    return { ...r, stream };
  },
});

/** The model for a task; each call is attributed to the workspace (spend per workspace sets pricing). */
export function model(task: Task, workspaceId: string) {
  return wrapLanguageModel({
    model: gateway(tasks[task]),
    middleware: [
      {
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
      },
      meterMiddleware(task, workspaceId),
    ],
  });
}
