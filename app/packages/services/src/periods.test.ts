import { describe, expect, it } from "vitest";
import { monthOf, periodOf, previousOf } from "./periods";

const iso = (p: { from: Date; to: Date }) => [p.from.toISOString(), p.to.toISOString()];

describe("usage periods (Sri Lanka time)", () => {
  it("a month starts at midnight in Colombo, 18:30 UTC the day before", () => {
    expect(iso(monthOf(new Date("2026-11-03T10:00:00Z")))).toEqual([
      "2026-10-31T18:30:00.000Z",
      "2026-11-30T18:30:00.000Z",
    ]);
  });
  it("the evening of the last day in UTC is already the next month in Colombo", () => {
    // 31 Oct 20:00 UTC = 1 Nov 01:30 in Colombo
    expect(monthOf(new Date("2026-10-31T20:00:00Z")).from.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });
  it("last month, and the month before it, across a year end", () => {
    const now = new Date("2027-01-10T00:00:00Z");
    const last = periodOf("last-month", now);
    expect(iso(last)).toEqual(["2026-11-30T18:30:00.000Z", "2026-12-31T18:30:00.000Z"]);
    expect(iso(previousOf("last-month", last))).toEqual(["2026-10-31T18:30:00.000Z", "2026-11-30T18:30:00.000Z"]);
    expect(iso(previousOf("month", periodOf("month", now)))).toEqual(iso(last));
  });
  it("n days back from now, and the n days before those", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const p = periodOf("7d", now);
    expect(iso(p)).toEqual(["2026-10-27T12:00:00.000Z", "2026-11-03T12:00:00.000Z"]);
    expect(iso(previousOf("7d", p))).toEqual(["2026-10-20T12:00:00.000Z", "2026-10-27T12:00:00.000Z"]);
  });
});
