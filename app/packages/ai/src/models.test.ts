import { flushUsage, type Metered, meter, setUsageSink, withUsage } from "@sllaw/usage";
import { gateway, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { meterMiddleware, priceOf } from "./models";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const finish = (input: number, output: number, generationId: string, reason: "tool-calls" | "stop") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: reason },
  usage: usage(input, output),
  providerMetadata: { gateway: { cost: "0.001", gatewayCost: "0.0012", generationId } },
});
// the parts of a provider stream, each on a later tick like a network stream (typed loosely: ai does not export them)
const stream = (parts: object[]) =>
  new ReadableStream<object>({
    async start(c) {
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, 1));
        c.enqueue(p);
      }
      c.close();
    },
  }) as unknown as ReadableStream<never>;

// step 1 calls a tool (which embeds, so it meters too), step 2 answers
function twoStepModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step++;
      return {
        stream: stream(
          step === 1
            ? [
                { type: "stream-start" as const, warnings: [] },
                { type: "tool-call" as const, toolCallId: "t1", toolName: "search", input: '{"q":"rent"}' },
                finish(100, 10, "g1", "tool-calls"),
              ]
            : [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "x" },
                { type: "text-delta" as const, id: "x", delta: "answer" },
                { type: "text-end" as const, id: "x" },
                finish(200, 20, "g2", "stop"),
              ],
        ),
      };
    },
  });
}

// the gateway's price list and generation records, never the network in a test
beforeEach(() => {
  vi.spyOn(gateway, "getAvailableModels").mockResolvedValue({
    models: [
      { id: "mock-model-id", pricing: { input: "0.000001", output: "0.000002", cachedInputTokens: "0.0000001" } },
    ],
  } as never);
  vi.spyOn(gateway, "getGenerationInfo").mockRejectedValue(new Error("Usage event not found"));
});
afterEach(() => {
  setUsageSink(null);
  vi.restoreAllMocks();
});

test("a streamed turn read after its scope closed is still metered for that user and chat, each step once", async () => {
  const events: Metered[] = [];
  setUsageSink(async (es) => void events.push(...es));
  const scope = { workspaceId: "w1", userId: "u1", task: "chat", ref: "chat:c1" };
  // as the chat route: the response is returned from inside the scope and read by the server after it
  const result = withUsage(scope, () =>
    streamText({
      model: wrapLanguageModel({ model: twoStepModel(), middleware: meterMiddleware("main", "w1") }),
      prompt: "q",
      tools: {
        search: tool({
          inputSchema: z.object({ q: z.string() }),
          execute: async () => {
            meter({ kind: "embed", model: "bge-m3", quantity: { texts: 1 } });
            return "hits";
          },
        }),
      },
      stopWhen: stepCountIs(2),
    }),
  );
  let text = "";
  for await (const t of result.textStream) text += t;
  await flushUsage();

  expect(text).toBe("answer");
  expect(events.map((e) => [e.kind, e.workspaceId, e.userId, e.task, e.ref])).toEqual([
    ["llm", "w1", "u1", "chat", "chat:c1"],
    ["embed", "w1", "u1", "chat", "chat:c1"],
    ["llm", "w1", "u1", "chat", "chat:c1"],
  ]);
  const llm = events.filter((e) => e.kind === "llm");
  expect(llm.map((e) => [e.quantity.input, e.quantity.output, e.costUsd, e.idem])).toEqual([
    [100, 10, 0.0012, "gateway:g1"],
    [200, 20, 0.0012, "gateway:g2"],
  ]);
});

test("outside any scope a call is metered for the model's workspace, with no user", async () => {
  const events: Metered[] = [];
  setUsageSink(async (es) => void events.push(...es));
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(5, 1),
      warnings: [],
    }),
  });
  const { generateText } = await import("ai");
  await generateText({ model: wrapLanguageModel({ model, middleware: meterMiddleware("files", "w2") }), prompt: "q" });
  await flushUsage();
  expect(events).toHaveLength(1);
  // no cost and no generation id: the tokens at the list price, marked estimated
  expect(events[0]).toMatchObject({ kind: "llm", workspaceId: "w2", userId: null, task: "files", estimated: true });
  expect(events[0].costUsd).toBeCloseTo(5 * 0.000001 + 1 * 0.000002);
});

test("a stream cut off before its finish (the stop button) is still metered, estimated, once", async () => {
  const events: Metered[] = [];
  setUsageSink(async (es) => void events.push(...es));
  const ac = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<object>({
        async start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "x" });
          c.enqueue({ type: "text-delta", id: "x", delta: "a".repeat(400) });
          // never finishes: the reader is stopped
        },
      }) as unknown as ReadableStream<never>,
    }),
  });
  const r = withUsage({ workspaceId: "w1", userId: "u1", task: "chat", ref: "chat:c1" }, () =>
    streamText({
      model: wrapLanguageModel({ model, middleware: meterMiddleware("main", "w1") }),
      prompt: "q",
      abortSignal: ac.signal,
    }),
  );
  for await (const t of r.textStream) if (t) ac.abort();
  await flushUsage();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: "llm", userId: "u1", task: "chat", estimated: true, meta: { cut: true } });
  expect(events[0].quantity.output).toBe(100); // 400 characters, about 4 a token
  expect(events[0].costUsd).toBeGreaterThan(100 * 0.000002);
});

test("a stream stopped before its reply began is metered too, its prompt only", async () => {
  const events: Metered[] = [];
  setUsageSink(async (es) => void events.push(...es));
  const ac = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  const r = withUsage({ workspaceId: "w1", userId: "u1", task: "chat", ref: "chat:c1" }, () =>
    streamText({
      model: wrapLanguageModel({ model, middleware: meterMiddleware("main", "w1") }),
      prompt: "q",
      abortSignal: ac.signal,
      onError: () => {},
    }),
  );
  await r.consumeStream();
  await flushUsage();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ userId: "u1", estimated: true, meta: { cut: true } });
  expect(events[0].quantity.output).toBe(0);
  expect(events[0].quantity.input).toBeGreaterThan(0);
});

test("a reply without its cost is priced from its generation record when the gateway has written it", async () => {
  vi.mocked(gateway.getGenerationInfo)
    .mockRejectedValueOnce(new Error("Usage event not found"))
    .mockResolvedValueOnce({ totalCost: 0.0042 } as never);
  const t = { input: 10, cached: 0, output: 10, reasoning: 0 };
  expect(await priceOf("mock-model-id", t, "gen_1", [0, 0, 0])).toBe(0.0042);
  // never written: the list price
  expect(await priceOf("mock-model-id", t, "gen_2", [0])).toBeCloseTo(10 * 0.000001 + 10 * 0.000002);
  expect(await priceOf("unknown/model", t, null)).toBeNull();
});
