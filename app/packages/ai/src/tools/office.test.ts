// The case office in the agent: its prompt section, its tools, and that a refused change comes back in words. Fake
// ports: no database, no model.
import { apply, emptyOffice, type Office, OfficeError, type Op } from "@sllaw/office";
import { describe, expect, it } from "vitest";
import { mainPrompt, mainTools } from "../agents/main";
import type { Ctx, OfficeChanged } from "../ports";
import { officeTools, officeView } from "./office";

const withDate = apply(
  emptyOffice(),
  [
    { op: "header.set", set: { court: "DC Colombo", caseNumber: "1234/P" } },
    { op: "date.add", date: "2026-12-12", purpose: "trial" },
    { op: "task.add", title: "List of witnesses", due: "2026-11-28" },
  ],
  "lawyer",
).office;

function fake(office: Office) {
  let now = office;
  const ctx = {
    caseId: "k",
    caseBrief: { title: "Silva v Perera", facts: "Partition." },
    caseFiles: [],
    caseOffice: office,
    today: "2026-11-10",
    asOfDate: "2026-11-10",
    ports: {
      officeRead: async () => now,
      officeChange: async (ops: Op[], summary: string): Promise<OfficeChanged> => {
        try {
          now = apply(now, ops, "ai").office;
          return { ok: true, summary, office: now };
        } catch (e) {
          if (e instanceof OfficeError) return { ok: false, error: e.message };
          throw e;
        }
      },
    },
  } as unknown as Ctx;
  const t = officeTools(ctx);
  const call = { toolCallId: "t", messages: [], context: {} };
  return {
    ctx,
    update: (input: Parameters<NonNullable<typeof t.caseUpdate.execute>>[0]) =>
      t.caseUpdate.execute!(input, call) as Promise<any>,
  };
}

describe("case office in the agent", () => {
  it("shows the office last in a case chat, fenced, with the ids the tools take", () => {
    const { ctx } = fake(withDate);
    const p = mainPrompt(ctx);
    expect(p.indexOf("# The case office")).toBeGreaterThan(p.indexOf("# The case files"));
    expect(p).toContain("<case_office>");
    expect(p).toContain('"caseNumber":"1234/P"');
    expect(p).toContain('"purpose":"trial"');
    expect(p).toContain("never by an id or a citation like f2, c7");
    expect(p).toContain('Never say "case office", "header", "widget" or "dashboard" to them');
    expect(Object.keys(mainTools(ctx))).toEqual(expect.arrayContaining(["caseRead", "caseUpdate"]));
  });

  it("a plain chat has neither the section nor the tools", () => {
    const { ctx } = fake(withDate);
    const plain = { ...ctx, caseId: null, caseBrief: null, caseOffice: null };
    expect(mainPrompt(plain)).not.toContain("# The case office");
    expect(Object.keys(mainTools(plain))).not.toContain("caseUpdate");
  });

  it("changes the office and reports the change", async () => {
    const { update } = fake(withDate);
    const r = await update({
      summary: "Added the plan task",
      ops: [{ op: "task.add", title: "Certified copy of the plan", due: "2026-11-14" }],
    });
    expect(r.summary).toBe("Added the plan task");
    expect(r.office.tasks.map((t: { title: string }) => t.title)).toEqual([
      "Certified copy of the plan",
      "List of witnesses",
    ]);
  });

  it("a pinned widget stays: the refusal comes back in words", async () => {
    const { update } = fake(withDate);
    expect(await update({ summary: "x", ops: [{ op: "widget.remove", id: "next_date" }] })).toMatch(
      /^Not changed: .*pinned/,
    );
    expect(await update({ summary: "x", ops: [{ op: "widget.hide", id: "tasks", hidden: true }] })).toMatch(/pinned/);
  });

  it("the view cuts long content and names the next date and what waits for an outcome", () => {
    const o = apply(
      withDate,
      [
        { op: "date.add", date: "2026-11-01", purpose: "calling" },
        { op: "widget.add", widget: { type: "note", title: "Strategy", text: "x".repeat(1000) } },
      ],
      "lawyer",
    ).office;
    const v = officeView(o, "2026-11-10");
    expect(v.nextDate?.date).toBe("2026-12-12");
    expect(v.awaitingOutcome.map((d) => d.date)).toEqual(["2026-11-01"]);
    const note = v.widgets.find((w) => w.type === "note") as { text: string };
    expect(note.text.length).toBeLessThan(400);
  });
});
