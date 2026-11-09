import { describe, expect, it } from "vitest";
import { dayOf } from "../periods";
import { LimitReached, maxesOf, over, type Plan, planOf, resetOf } from "./rules";

const free: Plan = { id: "f", key: "free", name: "Free", isDefault: true, limits: { messages: 10, tokens: 300_000 } };
const pro: Plan = { id: "p", key: "pro", name: "Pro", isDefault: false, limits: { messages: 200 } };
const now = new Date("2026-11-09T10:00:00Z");
const d = (s: string) => new Date(s);

describe("a user's plan", () => {
  it("is the default with no plan rows", () => {
    expect(planOf([free, pro], [], now)?.key).toBe("free");
  });
  it("is an active row's plan; an ended or future row does not count", () => {
    const rows = [
      { planId: "p", startsAt: d("2026-11-01T00:00:00Z"), endsAt: null },
      { planId: "f", startsAt: d("2026-12-01T00:00:00Z"), endsAt: null }, // not started
    ];
    expect(planOf([free, pro], rows, now)?.key).toBe("pro");
    expect(planOf([free, pro], [{ ...rows[0]!, endsAt: d("2026-11-09T09:00:00Z") }], now)?.key).toBe("free");
  });
  it("the latest start wins; a deleted plan falls through to the next", () => {
    const rows = [
      { planId: "f", startsAt: d("2026-10-01T00:00:00Z"), endsAt: null },
      { planId: "p", startsAt: d("2026-11-01T00:00:00Z"), endsAt: null },
    ];
    expect(planOf([free, pro], rows, now)?.key).toBe("pro");
    expect(planOf([free], rows, now)?.key).toBe("free");
  });
});

describe("the max for each metric", () => {
  it("is the plan's, or unlimited where the plan has none", () => {
    const m = maxesOf(free, [], now);
    expect(m.messages).toEqual({ max: 10, source: "plan" });
    expect(m.searches).toEqual({ max: null, source: "plan" });
  });
  it("a user's own limit replaces the plan's until it expires; null is unlimited", () => {
    const own = [
      { metric: "messages", max: 50, expiresAt: d("2026-12-31T00:00:00Z"), note: null },
      { metric: "tokens", max: null, expiresAt: null, note: null },
      { metric: "searches", max: 5, expiresAt: d("2026-11-01T00:00:00Z"), note: null }, // expired
    ];
    const m = maxesOf(free, own, now);
    expect(m.messages).toEqual({ max: 50, source: "user" });
    expect(m.tokens).toEqual({ max: null, source: "user" });
    expect(m.searches).toEqual({ max: null, source: "plan" });
  });
  it("no plan at all is unlimited", () => {
    expect(maxesOf(null, [], now).messages.max).toBeNull();
  });
});

describe("over a limit", () => {
  it("a counter blocks once reached (the next turn would add to it)", () => {
    expect(over("messages", 9, 10)).toBe(false);
    expect(over("messages", 10, 10)).toBe(true);
    expect(over("messages", 1e9, null)).toBe(false);
  });
  it("a cap blocks only when adding goes past it", () => {
    expect(over("case_files", 19, 20, 1)).toBe(false);
    expect(over("case_files", 20, 20, 1)).toBe(true);
    expect(over("storage", 900, 1000, 100)).toBe(false);
    expect(over("storage", 900, 1000, 101)).toBe(true);
  });
});

describe("resets", () => {
  it("daily counters at the next Colombo midnight (18:30 UTC), monthly on the 1st, caps never", () => {
    expect(resetOf("messages", now)?.toISOString()).toBe("2026-11-09T18:30:00.000Z");
    expect(resetOf("tokens_month", now)?.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    expect(resetOf("storage", now)).toBeNull();
  });
  it("just after Colombo midnight is already the next day", () => {
    // 9 Nov 19:00 UTC = 10 Nov 00:30 in Colombo
    expect(dayOf(d("2026-11-09T19:00:00Z")).from.toISOString()).toBe("2026-11-09T18:30:00.000Z");
  });
  it("the message names the plan and when it resets", () => {
    const e = new LimitReached("messages", 10, 10, "Free", resetOf("messages", now));
    expect(e.message).toBe(
      "You have sent today's 10 messages on the Free plan. You can send more at midnight (Sri Lanka time).",
    );
    expect(new LimitReached("tokens_month", 1, 1, "Free", resetOf("tokens_month", now)).message).toContain("on 1 Dec");
  });
});
