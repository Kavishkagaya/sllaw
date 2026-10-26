import { describe, expect, it } from "vitest";
import { chunkPages } from "./chunk";

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
});
