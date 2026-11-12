// Every LLM call goes through Vercel AI Gateway (AI_GATEWAY_API_KEY locally, OIDC on Vercel): one key for every
// provider, spend per workspace (`user`), fallbacks. The model per task is config, picked later (docs/APP.md): set
// MODEL_<TASK> ("provider/model", as the gateway names it) to change one without touching code.
import { meter, roughTokens, type Scope, usageScope } from "@sllaw/usage";
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
type Tokens = { input: number; cached: number; output: number; reasoning: number };

// The gateway's list prices per token (GET /v1/models), read once an instance: for a call it billed without telling us.
let prices: Promise<Map<string, { input: number; output: number; cached: number }>> | null = null;
const priceList = () =>
  (prices ??= gateway
    .getAvailableModels()
    .then(
      (r) =>
        new Map(
          r.models.flatMap((m) =>
            m.pricing
              ? [
                  [
                    m.id,
                    {
                      input: Number(m.pricing.input),
                      output: Number(m.pricing.output),
                      cached: Number(m.pricing.cachedInputTokens ?? m.pricing.input),
                    },
                  ] as const,
                ]
              : [],
          ),
        ),
    )
    .catch((e) => {
      prices = null; // asked again next time
      throw e;
    }));

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the gateway charged for a call that came back without its cost: its generation record (written a few seconds
 *  later), else the tokens at the list price; null when neither is known. Always an estimate. */
export async function priceOf(modelId: string, t: Tokens, generationId: string | null, waits = [2000, 4000, 8000]) {
  if (generationId)
    for (const ms of waits) {
      await pause(ms);
      try {
        return (await gateway.getGenerationInfo({ id: generationId })).totalCost;
      } catch {} // not written yet, or not found: wait and ask again
    }
  try {
    const p = (await priceList()).get(modelId);
    return p ? (t.input - t.cached) * p.input + t.cached * p.cached + t.output * p.output : null;
  } catch {
    return null;
  }
}

/** Records one gateway call (a model step, a decision) for `scope`: its tokens, and what the gateway billed. With
 *  no billed cost (a reply without one, or a stream cut off before its end: `cut`), it is priced by priceOf and
 *  marked estimated. Every call to the gateway is recorded here, once. */
export function meterCall(scope: Scope, task: string, modelId: string, t: Tokens, meta: unknown, cut = false) {
  const g = ((meta as { gateway?: GatewayMeta } | undefined)?.gateway ?? {}) as GatewayMeta;
  const billed = g.gatewayCost ?? g.cost;
  const generationId = g.generationId ?? null;
  const event = (costUsd: number | null, estimated: boolean) => ({
    kind: "llm" as const,
    task,
    model: modelId,
    quantity: t,
    costUsd,
    estimated,
    idem: generationId ? `gateway:${generationId}` : null,
    meta: {
      provider: g.routing?.finalProvider ?? null,
      inferenceCost: g.cost == null ? null : Number(g.cost),
      ...(cut && { cut: true }),
    },
  });
  meter(
    billed != null ? event(Number(billed), false) : priceOf(modelId, t, generationId).then((c) => event(c, true)),
    scope,
  );
}

const tokensOf = (u: ModelUsage): Tokens => ({
  input: u.inputTokens.total ?? 0,
  cached: u.inputTokens.cacheRead ?? 0,
  output: u.outputTokens.total ?? 0,
  reasoning: u.outputTokens.reasoning ?? 0,
});

/** The decision model that names a file's type (MODEL_CLASSIFY): Jev, input billed, output free. A language model id
 *  here (e.g. "deepseek/...") makes the classifier ask that model instead. */
export const CLASSIFY_MODEL = process.env.MODEL_CLASSIFY || "typesafe-ai/jev-1.14.0";

/** Meters one decision call (no middleware for decision models), as any other gateway call. */
export const meterDecision = (
  workspaceId: string,
  modelId: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  meta: unknown,
) =>
  meterCall(
    usageScope() ?? { workspaceId },
    "classify",
    modelId,
    { input: usage?.inputTokens ?? 0, cached: 0, output: usage?.outputTokens ?? 0, reasoning: 0 },
    meta,
  );

/** Meters every call, streamed (the chat: one per step) or not (categorize), for the usage scope the call started
 *  in (a stream's finish part may be read outside it), else for the workspace. A stream cut off before its finish
 *  part (the stop button, a timeout) is still metered: its tokens counted roughly (the prompt's and the text that
 *  came), priced by priceOf. */
export const meterMiddleware = (task: Task, workspaceId: string): LanguageModelMiddleware => ({
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, model }) => {
    const scope = usageScope() ?? { workspaceId };
    const r = await doGenerate();
    meterCall(scope, task, model.modelId, tokensOf(r.usage), r.providerMetadata);
    return r;
  },
  wrapStream: async ({ doStream, model, params }) => {
    const scope = usageScope() ?? { workspaceId };
    let done = false;
    let chars = 0; // text, reasoning and tool input that came before a cut
    const cut = () => {
      if (done) return;
      done = true;
      const input = roughTokens(JSON.stringify([params.prompt, params.tools ?? []]).length); // tools are billed input too
      meterCall(
        scope,
        task,
        model.modelId,
        { input, cached: 0, output: roughTokens(chars), reasoning: 0 },
        undefined,
        true,
      );
    };
    let r: Awaited<ReturnType<DoStream>>;
    try {
      r = await doStream();
    } catch (e) {
      if (params.abortSignal?.aborted) cut(); // stopped before the reply began: the prompt may still be billed
      throw e;
    }
    const reader = r.stream.getReader();
    const stream = new ReadableStream<Part>({
      async pull(out) {
        try {
          const { done: end, value: part } = await reader.read();
          if (end) {
            cut(); // ended with no finish part
            return out.close();
          }
          if (part.type === "finish" && !done) {
            done = true;
            meterCall(scope, task, model.modelId, tokensOf(part.usage), part.providerMetadata);
          } else if ("delta" in part && typeof part.delta === "string") chars += part.delta.length;
          out.enqueue(part);
        } catch (e) {
          cut(); // aborted (the stop button) or the connection broke
          out.error(e);
        }
      },
      cancel(reason) {
        cut(); // the reader stopped reading
        return reader.cancel(reason);
      },
    });
    return { ...r, stream };
  },
});

/** The gateway's own spend report over UTC days [startDate, endDate] (YYYY-MM-DD): what it billed and for how many
 *  requests, for every caller of the team's gateway. Only to reconcile our ledger (docs/APP.md): aggregated, late,
 *  and for Pro teams only, so it throws when unavailable. */
export async function gatewaySpend(startDate: string, endDate: string) {
  const r = await gateway.getSpendReport({ startDate, endDate });
  return {
    costUsd: r.results.reduce((s, x) => s + x.totalCost, 0),
    requests: r.results.reduce((s, x) => s + (x.requestCount ?? 0), 0),
  };
}

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
