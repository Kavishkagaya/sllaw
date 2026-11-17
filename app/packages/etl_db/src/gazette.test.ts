import { describe, expect, it } from "vitest";
import { gazetteSubject, gazetteTitle } from "./gazette";

// titles as the documents.gov.lk listing gives them (kb.docs.title, sampled 2026-11-17)
describe("gazetteTitle", () => {
  it("drops the department and adds the number and date", () => {
    expect(
      gazetteTitle({
        key: "gazette:1989/61",
        title:
          "Ministry of Health, Nutrition and Indigenous Medicine - The National Medicines Regulatory Authority (Ceiling on Prices) Regulations No. 2 of 2016",
        date: "2016-10-21",
      }),
    ).toBe(
      "The National Medicines Regulatory Authority (Ceiling on Prices) Regulations No. 2 of 2016, Gazette No. 1989/61 (21.10.2016)",
    );
  });
  it("cuts a long subject at a word and keeps a short one whole", () => {
    const long = gazetteSubject(
      "Imports and Exports Control Department - The Imports and Exports (Control) Regulations No. 12 of 2023 Motor Vehicles for the Transport Ten or more Persons and other Vehicles",
    );
    expect(long?.endsWith("…")).toBe(true);
    expect(long!.length).toBeLessThanOrEqual(101);
    expect(gazetteSubject("Urban Development Authority - Planning and Development Regulation - 2021 ")).toBe(
      "Planning and Development Regulation - 2021",
    );
    expect(gazetteSubject("Ministry - Short")).toBe("Ministry - Short"); // too little after the dash to drop it
  });
  it("names the gazette without a title or date", () => {
    expect(gazetteTitle({ key: "gazette:2345/03", title: null, date: null })).toBe("Gazette No. 2345/03");
  });
});
