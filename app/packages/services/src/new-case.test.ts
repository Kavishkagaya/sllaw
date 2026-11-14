import { apply, emptyOffice } from "@sllaw/office";
import { describe, expect, it } from "vitest";
import { type NewCase, newCaseFacts, newCaseOps } from "./new-case";

const card: NewCase = {
  title: "Perera v. Silva",
  court: "District Court of Colombo",
  caseNumber: "12345/L",
  kind: "land: declaration of title and ejectment",
  side: "plaintiff",
  stage: "trial",
  client: "Perera",
  parties: [
    { name: "Silva", role: "opposing_party" },
    { name: " ", role: "other" },
  ],
  nextDate: { date: "2026-12-03", purpose: "trial" },
  missing: [{ fact: "When was the deed executed?", why: "prescription runs from possession" }],
};

describe("a new case's page", () => {
  it("fills the header, the client and parties, and the next date with the office operations", () => {
    const { office } = apply(emptyOffice(), newCaseOps(card), "lawyer");
    expect(office.header).toMatchObject({
      court: "District Court of Colombo",
      caseNumber: "12345/L",
      side: "plaintiff",
      stage: "trial",
      client: "Perera",
    });
    expect(office.people.map((p) => [p.name, p.role])).toEqual([
      ["Perera", "client"],
      ["Silva", "opposing_party"],
    ]);
    expect(office.dates).toMatchObject([{ date: "2026-12-03", court: "District Court of Colombo", purpose: "trial" }]);
  });

  it("leaves out what the card left empty", () => {
    const empty: NewCase = {
      ...card,
      court: "",
      caseNumber: "",
      kind: "",
      side: "",
      stage: "",
      client: "",
      parties: [],
      nextDate: null,
    };
    expect(newCaseOps(empty)).toEqual([]);
  });

  it("keeps the lawyer's text as written and lists the missing facts with why", () => {
    expect(newCaseFacts(" client Perera ", card.missing)).toBe(
      "client Perera\n\nStill to find out:\n- When was the deed executed? (prescription runs from possession)",
    );
    expect(newCaseFacts("", [])).toBe("");
  });
});
