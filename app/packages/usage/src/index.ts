// Metered usage (docs/APP.md, Usage): one event per call that costs us money or counts toward a plan: a model call,
// an embedding, an OCR'd file, a vector DB call, bytes stored. Product analytics (clicks, pages) are not events here.
//
// The packages that spend (ai, search, extract) call meter() where the call's size and cost are known. Who it was for
// comes from the scope services opens around the work (withUsage: a chat turn, a file step), so nothing below
// services takes a workspace id just to be metered. Where events go is the sink services sets (setUsageSink: the
// app database); with none set they are dropped (tests, scripts). Writes are not awaited by the caller: flushUsage()
// waits for them, and services calls it before the function may end (chat onFinish, the end of a file step).
//
// This package imports nothing of ours, so every package may import it (ai included).
import { AsyncLocalStorage } from "node:async_hooks";

// action: something the user did that a plan limits but that costs nothing itself (a message sent)
export type Kind = "llm" | "embed" | "ocr" | "vector" | "storage" | "action";

/** Who the usage is for and what it was part of. */
export type Scope = {
  workspaceId: string | null;
  userId?: string | null;
  task?: string; // what the user did: chat, file.extract, file.categorize, file.index, upload, delete
  ref?: string | null; // chat:<id>, file:<id>
};

export type UsageEvent = {
  kind: Kind;
  task?: string; // used when no scope names one
  model?: string | null; // provider/model or service: deepseek/deepseek-v4.1-flash, @cf/baai/bge-m3, mistral-ocr-latest
  quantity: Record<string, number>; // tokens, texts, chars, pages, bytes, calls: whatever the call is priced by
  costUsd?: number | null; // what we pay; null when unknown (a free tier, a self-hosted model)
  estimated?: boolean; // costUsd from PRICES, not from the provider's bill
  idem?: string | null; // the provider's id for the call (gateway generation id): stored once
  meta?: Record<string, unknown>; // counts and ids only, never client text
};

/** An event as stored: the event, its scope, and when. */
export type Metered = Omit<UsageEvent, "task"> &
  Required<Pick<Scope, "workspaceId">> & {
    userId: string | null;
    task: string;
    ref: string | null;
    at: Date;
  };

export type Sink = (events: Metered[]) => Promise<void>;

/** List prices, for calls whose provider returns no cost. USD. Change them here when the provider does. */
export const PRICES = {
  // Workers AI @cf/baai/bge-m3, per input token (PIPELINE.md: $0.0118 per million, 2026-10-16)
  bgeM3Token: 0.0118 / 1e6,
  // Mistral OCR, per page (APP.md: about $4 per 1,000 pages, surveyed 2026-10-26)
  mistralOcrPage: 4 / 1000,
};

const als = new AsyncLocalStorage<Scope>();
let sink: Sink | null = null;
const pending = new Set<Promise<void>>();

/** Where events go from now on (services: the app database); null drops them. */
export const setUsageSink = (s: Sink | null) => void (sink = s);

/** Runs fn with this scope: every event metered inside it, awaited or not, is for this workspace, user and task.
 *  A scope inside another adds to it (a file step inside a request keeps the request's user). */
export function withUsage<T>(scope: Scope, fn: () => T): T {
  return als.run({ ...als.getStore(), ...scope }, fn);
}

export const usageScope = (): Scope | undefined => als.getStore();

/** Records one event for the current scope (or `scope`, for work outside one). Never throws and never waits: a
 *  failed write is logged, not passed to the caller, since a user's request must not fail on metering. The event
 *  may be a promise (a cost still being looked up); flushUsage waits for it too. */
export function meter(e: UsageEvent | Promise<UsageEvent>, scope: Scope | undefined = als.getStore()) {
  if (!sink) return;
  const at = new Date();
  const write = (s: Sink, { task, ...rest }: UsageEvent) =>
    s([
      {
        ...rest,
        workspaceId: scope?.workspaceId ?? null,
        userId: scope?.userId ?? null,
        task: scope?.task ?? task ?? "unknown",
        ref: scope?.ref ?? null,
        at,
      },
    ]);
  const s = sink;
  const p = Promise.resolve(e)
    .then((ev) => write(s, ev))
    .catch((err) => console.error("usage: event not stored", err));
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Waits for every event metered so far to be written. Call before the function may end. */
export async function flushUsage() {
  while (pending.size) await Promise.all([...pending]);
}

/** Tokens in a text, roughly, for providers that return no count (about 4 characters a token in English). */
export const roughTokens = (chars: number) => Math.ceil(chars / 4);
