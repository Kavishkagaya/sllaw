import { Unreadable } from "@sllaw/extract";
import { describe, expect, it } from "vitest";
import { isRetryable } from "./errors";

const withStatus = (status: number) => Object.assign(new Error(`http ${status}`), { status });

describe("isRetryable", () => {
  it.each([408, 425, 429, 500, 503])("retries HTTP %i", (s) => {
    expect(isRetryable(withStatus(s))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %i", (s) => {
    expect(isRetryable(withStatus(s))).toBe(false);
  });

  it("retries an unknown error (a network drop, a timeout)", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });

  it("does not retry a file its parser cannot read", () => {
    expect(isRetryable(new Unreadable("corrupt"))).toBe(false);
  });

  it("follows the error's own flag first (ours, then the AI SDK's)", () => {
    expect(isRetryable(Object.assign(withStatus(500), { retryable: false }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("model said no"), { isRetryable: false }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("model busy"), { isRetryable: true }))).toBe(true);
  });
});
