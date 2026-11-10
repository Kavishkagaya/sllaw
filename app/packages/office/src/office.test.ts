import { describe, expect, it } from "vitest";
import {
  addDays,
  apply,
  awaitingOutcome,
  emptyOffice,
  journal,
  nextDate,
  type Office,
  OfficeError,
  officeSchema,
  restore,
} from ".";

const ids = () => {
  let n = 0;
  return () => `i${++n}`;
};

describe("schema", () => {
  it("accepts the empty office and refuses a widget outside the catalog", () => {
    expect(officeSchema.safeParse(emptyOffice()).success).toBe(true);
    const bad = {
      ...emptyOffice(),
      widgets: [...emptyOffice().widgets, { id: "x", type: "iframe", collapsed: false }],
    };
    expect(officeSchema.safeParse(bad).success).toBe(false);
  });
  it("refuses an office larger than MAX_DOC", () => {
    const o = emptyOffice();
    o.tasks = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`,
      title: "x".repeat(300),
      due: null,
      done: false,
      by: "lawyer" as const,
    }));
    o.people = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`,
      name: "n",
      role: "other" as const,
      phone: "",
      email: "",
      note: "x".repeat(1000),
      by: "lawyer" as const,
    }));
    o.widgets.push(
      ...Array.from({ length: 35 }, (_, i) => ({
        id: `w${i}`,
        type: "note" as const,
        title: "N",
        text: "x".repeat(20_000),
        collapsed: false,
        by: "ai" as const,
      })),
    );
    expect(officeSchema.safeParse(o).success).toBe(false);
  });

  it("refuses an office without a core widget", () => {
    const o = emptyOffice();
    o.widgets = o.widgets.filter((w) => w.type !== "next_date");
    expect(officeSchema.safeParse(o).success).toBe(false);
  });
});

describe("apply", () => {
  it("fills the header and marks who set each field", () => {
    const { office, items } = apply(
      emptyOffice(),
      [{ op: "header.set", set: { court: "DC Colombo", side: "defendant" } }],
      "ai",
    );
    expect(office.header).toMatchObject({ court: "DC Colombo", side: "defendant", by: { court: "ai", side: "ai" } });
    expect(items.map((i) => i.key)).toEqual(["header"]);
  });

  it("refuses bad data and leaves the office as it was", () => {
    const o = emptyOffice();
    expect(() => apply(o, [{ op: "task.update", id: "nope", set: { done: true } }], "lawyer")).toThrow(OfficeError);
    expect(() =>
      apply(o, [{ op: "widget.add", widget: { type: "table", title: "T", columns: ["a"], rows: [["1", "2"]] } }], "ai"),
    ).toThrow(/more cells/);
    expect(o).toEqual(emptyOffice());
  });

  it("keeps core widgets pinned against the agent", () => {
    const o = emptyOffice();
    expect(() => apply(o, [{ op: "widget.remove", id: "next_date" }], "ai")).toThrow(/pinned/);
    expect(() => apply(o, [{ op: "widget.hide", id: "tasks", hidden: true }], "ai")).toThrow(/pinned/);
    expect(() => apply(o, [{ op: "widget.remove", id: "tasks" }], "lawyer")).toThrow(/hide it/);
    expect(
      apply(o, [{ op: "widget.hide", id: "people", hidden: true }], "lawyer").office.widgets.find(
        (w) => w.id === "people",
      ),
    ).toMatchObject({ hidden: true });
    // the agent may move and collapse them
    const moved = apply(
      o,
      [
        { op: "widget.move", id: "tasks", to: 0 },
        { op: "widget.collapse", id: "journal", collapsed: true },
      ],
      "ai",
    );
    expect(moved.office.widgets[0]!.id).toBe("tasks");
  });

  it("refuses content a widget type does not have", () => {
    const { office } = apply(
      emptyOffice(),
      [{ op: "widget.add", widget: { type: "note", title: "Strategy", text: "x" } }],
      "ai",
      ids(),
    );
    expect(() => apply(office, [{ op: "widget.update", id: "i1", set: { rows: [["a"]] } }], "ai")).toThrow(/no rows/);
  });

  it("records an outcome and makes the date the court gave the next date", () => {
    const mint = ids();
    let o = apply(
      emptyOffice(),
      [{ op: "date.add", date: "2026-12-12", court: "DC Colombo", purpose: "trial" }],
      "lawyer",
      mint,
    ).office;
    expect(nextDate(o, "2026-11-10")?.date).toBe("2026-12-12");
    expect(awaitingOutcome(o, "2026-12-13").map((d) => d.date)).toEqual(["2026-12-12"]);
    o = apply(
      o,
      [
        {
          op: "date.outcome",
          id: "i1",
          outcome: "Court did not sit.",
          next: { date: "2027-01-15", purpose: "further trial" },
        },
      ],
      "lawyer",
      mint,
    ).office;
    expect(awaitingOutcome(o, "2026-12-13")).toEqual([]);
    expect(nextDate(o, "2026-12-13")).toMatchObject({
      date: "2027-01-15",
      court: "DC Colombo",
      purpose: "further trial",
    });
    expect(journal(o).map((d) => d.date)).toEqual(["2027-01-15", "2026-12-12"]);
  });
});

describe("undo", () => {
  it("puts back exactly what one change touched, keeping later changes", () => {
    const mint = ids();
    const start: Office = apply(
      emptyOffice(),
      [{ op: "task.add", title: "List of witnesses", due: "2026-11-28" }],
      "lawyer",
      mint,
    ).office;
    const ai = apply(
      start,
      [
        { op: "task.add", title: "Certified copy of the plan", due: "2026-11-14" },
        {
          op: "widget.add",
          widget: { type: "table", title: "Witnesses", columns: ["Name", "Proves"], rows: [] },
          at: 0,
        },
        { op: "task.update", id: "i1", set: { due: "2026-11-30" } },
      ],
      "ai",
      mint,
    );
    // the lawyer works on after it
    const later = apply(ai.office, [{ op: "header.set", set: { court: "DC Colombo" } }], "lawyer", mint).office;
    const undone = restore(later, ai.items);
    expect(undone.tasks).toEqual(start.tasks);
    expect(undone.widgets).toEqual(start.widgets);
    expect(undone.header.court).toBe("DC Colombo");
  });
});

it("addDays crosses months", () => expect(addDays("2026-11-28", 7)).toBe("2026-12-05"));
