import { flushUsage, type Metered, meter, setUsageSink, withUsage } from "@sllaw/usage";
import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { meterMiddleware } from "./models";

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

afterEach(() => setUsageSink(null));

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
  expect(events[0]).toMatchObject({ kind: "llm", workspaceId: "w2", userId: null, task: "files", costUsd: null });
});
