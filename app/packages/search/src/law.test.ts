import { describe, expect, it } from "vitest";
import { filterExpr } from "./law";

describe("filterExpr", () => {
  it("narrows to laws, judgments or one court", () => {
    expect(filterExpr({ only: "laws" })).toBe(`kind != "judgment"`);
    expect(filterExpr({ only: "judgments" })).toBe(`kind == "judgment"`);
    expect(filterExpr({ only: "courtOfAppeal" })).toBe(`doc_key like "ca:%"`);
    expect(filterExpr({ only: "supremeCourt", yearFrom: 2023 })).toBe(`doc_key like "sc:%" and year >= 2023`);
  });
  it("refuses a value it does not know", () => {
    expect(() => filterExpr({ only: "all" as never })).toThrow(/bad filter/);
    expect(() => filterExpr({ docKeys: ['ca:x" or 1==1'] })).toThrow(/bad filter/);
  });
});
