// The public Coverage page's counts: one query per hour per instance, and a failed query is not kept.
import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.fn();
vi.mock("@sllaw/etl_db", () => ({ coverageCounts: () => counts(), docInfo: vi.fn(), docWithChunks: vi.fn() }));
vi.mock("./agent", () => ({ asOf: vi.fn() }));

const row = { acts: 3227, chapters: 997, amendments: 20075, updated: "2026-11-14 02:10:00+00" };

describe("coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    counts.mockReset();
  });

  it("asks kb once an hour", async () => {
    const { coverage } = await import("./corpus");
    counts.mockResolvedValue(row);
    expect(await coverage(0)).toEqual(row);
    await coverage(3_599_000);
    expect(counts).toHaveBeenCalledTimes(1);
    await coverage(3_600_001);
    expect(counts).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed query", async () => {
    const { coverage } = await import("./corpus");
    counts.mockRejectedValueOnce(new Error("Neon down")).mockResolvedValue(row);
    await expect(coverage(0)).rejects.toThrow("Neon down");
    expect(await coverage(1000)).toEqual(row);
    expect(counts).toHaveBeenCalledTimes(2);
  });
});
