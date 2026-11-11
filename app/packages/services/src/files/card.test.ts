// Card edits: what a patch changes and marks as typed, and what a re-read for a new type keeps.
import type { Card } from "@sllaw/ai";
import { describe, expect, it } from "vitest";
import { applyPatch, keepEdited } from "./card";

const card = (over: Partial<Card> = {}): Card => ({
  docType: "letter",
  title: "Letter",
  language: "en",
  summary: "A letter.",
  parties: [],
  dates: [],
  court: null,
  caseNumbers: [],
  lawsCited: [],
  tags: [],
  fields: {},
  typedBy: "jev",
  typeConfidence: 0.9,
  edited: [],
  ...over,
});

describe("applyPatch", () => {
  it("changes what is given and marks it typed", () => {
    const c = applyPatch(card({ docType: "letter_of_demand", fields: { amount: null } }), {
      title: "Demand",
      fields: { amount: "Rs. 640,000" },
    });
    expect(c.title).toBe("Demand");
    expect(c.fields.amount).toBe("Rs. 640,000");
    expect(c.edited).toEqual(["title", "fields.amount"]);
  });
  it("edits details stored before fields and edited existed", () => {
    const old = { ...card(), fields: undefined, edited: undefined } as unknown as Card;
    expect(applyPatch(old, { title: "T" }).edited).toEqual(["title"]);
  });
  it("drops a field the type does not have", () => {
    const c = applyPatch(card(), { fields: { amount: "Rs. 1" } });
    expect(c.fields).toEqual({});
    expect(c.edited).toEqual([]);
  });
});

describe("keepEdited", () => {
  it("keeps typed values across a new type, drops typed fields the new type lacks", () => {
    const old = card({
      docType: "letter_of_demand",
      title: "My title",
      fields: { amount: "Rs. 5", deadline: "2024-01-01" },
      edited: ["title", "fields.amount"],
    });
    const fresh = card({
      docType: "plaint",
      title: "Plaint",
      fields: { reliefs: [], causeOfAction: null, value: null },
    });
    const c = keepEdited(old, fresh);
    expect(c.docType).toBe("plaint");
    expect(c.title).toBe("My title");
    expect(c.fields).toEqual({ reliefs: [], causeOfAction: null, value: null });
    expect(c.edited).toEqual(["title"]);
  });
});
