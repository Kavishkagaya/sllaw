import { describe, expect, it } from "vitest";
import { chunkPages, cut } from "./chunk";

describe("chunkPages", () => {
  const cs = chunkPages("f", [{ n: 1, text: "a. ".repeat(1200) }, { n: 2, text: "Short page." }]);

  it("keeps every chunk within 1500 chars", () => {
    expect(cs.every((c) => c.text.length <= 1500)).toBe(true);
  });

  it("never runs a chunk across a page", () => {
    expect(cs.at(-1)).toMatchObject({ page: 2, text: "Short page." });
  });

  it("numbers chunks <fileId>:<n> in order", () => {
    expect(cs.map((c) => c.id)).toEqual(cs.map((_, i) => `f:${i}`));
  });

  it("drops no text from a run with no spaces", () => {
    const t = "A".repeat(2000) + "B".repeat(1000);
    const cs = chunkPages("f", [{ n: 1, text: t }]);
    expect(cs.map((c) => c.text).join("")).toBe(t);
    expect(cs.every((c) => c.text.length <= 1500)).toBe(true);
  });

  it("drops no words from a long paragraph with no sentence ends", () => {
    const t = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const cs = chunkPages("f", [{ n: 1, text: t }]);
    expect(cs.map((c) => c.text).join(" ")).toBe(t);
    expect(cs.every((c) => c.text.length <= 1500)).toBe(true);
  });

  it("keeps every word of mixed text: long words, short sentences, Sinhala", () => {
    const t = ["කොළඹ දිසා අධිකරණය. ".repeat(80), "x".repeat(1700), " short. ".repeat(50), "https://e.lk/" + "q".repeat(3200)].join(" ");
    const cs = chunkPages("f", [{ n: 1, text: t }]);
    expect(cs.every((c) => c.text.length <= 1500)).toBe(true);
    expect(cs.map((c) => c.text).join("").replace(/\s+/g, "")).toBe(t.replace(/\s+/g, ""));
  });

  it("cuts at a space when one fits, and never splits an emoji", () => {
    expect(cut(`${"a".repeat(1400)} ${"b".repeat(200)}`).map((p) => p.length)).toEqual([1400, 200]);
    const e = cut("a".repeat(1499) + "😀" + "b");
    expect(e[0]).toBe("a".repeat(1499));
    expect(e.join("")).toBe("a".repeat(1499) + "😀" + "b");
  });
});
