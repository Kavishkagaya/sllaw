import { describe, expect, it } from "vitest";
import { gazetteStatus } from "./law";

describe("gazetteStatus (chat-regulations d4)", () => {
  it("names the later gazettes, the rescission first", () => {
    expect(
      gazetteStatus([
        { kind: "amends", by: "gazette:2049/31", date: "2017-12-14" },
        { kind: "amends", by: "gazette:2086/37", date: "2018-08-31" },
        { kind: "rescinds", by: "gazette:2123/35", date: "2019-05-15" },
      ]),
    ).toBe(
      "rescinded by gazette:2123/35 (2019-05-15); amended by gazette:2049/31 (2017-12-14), gazette:2086/37 (2018-08-31)",
    );
  });
  it("says when none is recorded", () => {
    expect(gazetteStatus(undefined)).toBe("no later gazette amending or rescinding it recorded");
  });
});
