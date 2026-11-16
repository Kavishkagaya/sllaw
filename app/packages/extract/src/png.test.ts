import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { png } from "./png";

describe("png", () => {
  it("writes the pixels row by row, each after a filter byte", () => {
    const px = new Uint8Array([1, 2, 3, 4, 5, 6]); // 3x2 grey
    const out = png(px, 3, 2, 1);
    expect(out.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect([out.readUInt32BE(16), out.readUInt32BE(20), out[24], out[25]]).toEqual([3, 2, 8, 0]);
    const idat = out.indexOf("IDAT", 0, "latin1");
    const len = out.readUInt32BE(idat - 4);
    expect([...inflateSync(out.subarray(idat + 4, idat + 4 + len))]).toEqual([0, 1, 2, 3, 0, 4, 5, 6]);
  });
});
