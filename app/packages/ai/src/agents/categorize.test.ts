// The reader's pure parts: page text for the readPages tool, and the card schema per type.
import { describe, expect, it } from "vitest";
import { cardSchema, pageText } from "./categorize";
import { FIELDS } from "./doc-types";

const pages = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: `text of page ${i + 1}` }));

describe("pageText", () => {
  it("returns the asked pages under their marks", () => {
    const t = pageText(pages, 2, 3);
    expect(t).toContain("[page 2]\ntext of page 2");
    expect(t).toContain("[page 3]");
    expect(t).not.toContain("[page 4]");
  });
  it("cuts at the character limit and says so", () => {
    const t = pageText(pages, 1, 5, 30);
    expect(t).toMatch(/cut at 30 characters/);
    expect(t.length).toBeLessThan(80);
  });
  it("says when there are no such pages", () => expect(pageText(pages, 9, 12)).toBe("(no such pages)"));
});

describe("cardSchema", () => {
  const base = {
    title: "t",
    language: "en",
    summary: "s",
    parties: [],
    dates: [],
    court: null,
    caseNumbers: [],
    lawsCited: [],
    tags: [],
  };
  it("asks a journal entry for its next date, and nothing of a type without fields", () => {
    expect(Object.keys(cardSchema("journal_entry").shape.fields.shape)).toEqual(
      FIELDS.journal_entry?.map((f) => f.key),
    );
    expect(cardSchema("receipt").parse({ ...base, fields: {} }).fields).toEqual({});
  });
  it("takes null for a text field the document does not give, and a list for a list", () => {
    const r = cardSchema("plaint").parse({ ...base, fields: { reliefs: ["rent"], causeOfAction: null, value: null } });
    expect(r.fields).toEqual({ reliefs: ["rent"], causeOfAction: null, value: null });
    expect(() =>
      cardSchema("plaint").parse({ ...base, fields: { reliefs: "rent", causeOfAction: null, value: null } }),
    ).toThrow();
  });
});
