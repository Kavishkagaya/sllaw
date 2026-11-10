// The case office in the agent (a case chat only): what the prompt shows of it (officeView), and two tools. caseRead
// gives the office in full, or one widget; caseUpdate changes it with the same operations the lawyer's page uses
// (@sllaw/office). A change lands at once, marked "by AI", and the lawyer can undo it from the chat card or the
// history. The rules that matter are in the operations, not here: core widgets cannot be hidden or removed by the
// agent, an item that is not there is an error in words, and the result is checked against the schema.
import { awaitingOutcome, journal, nextDate, type Office, opsSchema, sortedTasks } from "@sllaw/office";
import { tool } from "ai";
import { z } from "zod";
import type { Ctx } from "../ports";

const CUT = 300; // chars of a note's text, a person's note or an outcome in the view
const ROWS = 5; // rows, items, events per custom widget in the view
const DATES = 12; // journal dates in the view (the upcoming ones and the newest past)
const LIST = 40; // open tasks and people in the view; caseRead has the rest
const READ_MAX = 40_000; // chars of caseRead's answer: a full office can be far larger than a model turn should carry

const cut = (s: string, n = CUT) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The office as the model reads it: compact JSON with every id it may name in caseUpdate. Long content is cut;
 *  caseRead gives it whole. */
export function officeView(o: Office, today: string) {
  const { open, done } = sortedTasks(o);
  const next = nextDate(o, today);
  const header = Object.fromEntries(Object.entries(o.header).filter(([k, v]) => k !== "by" && v !== ""));
  return {
    today,
    header,
    nextDate: next && { id: next.id, date: next.date, court: next.court, purpose: next.purpose },
    awaitingOutcome: awaitingOutcome(o, today).map((d) => ({ id: d.id, date: d.date, purpose: d.purpose })),
    dates: journal(o)
      .slice(0, DATES)
      .map((d) => ({
        id: d.id,
        date: d.date,
        court: d.court,
        purpose: d.purpose,
        outcome: d.outcome && cut(d.outcome),
      })),
    olderDates: Math.max(0, o.dates.length - DATES),
    tasks: open.slice(0, LIST).map((t) => ({ id: t.id, title: t.title, due: t.due })),
    moreTasks: Math.max(0, open.length - LIST),
    doneTasks: done.length,
    people: o.people
      .slice(0, LIST)
      .map((p) => ({ id: p.id, name: p.name, role: p.role, ...(p.note && { note: cut(p.note, 120) }) })),
    widgets: o.widgets.map((w) => {
      const base = { id: w.id, type: w.type, ...(w.collapsed && { collapsed: true }) };
      switch (w.type) {
        case "note":
          return { ...base, title: w.title, text: cut(w.text) };
        case "checklist":
          return { ...base, title: w.title, items: w.items.slice(0, ROWS), more: Math.max(0, w.items.length - ROWS) };
        case "table":
          return {
            ...base,
            title: w.title,
            columns: w.columns,
            rows: w.rows.slice(0, ROWS),
            more: Math.max(0, w.rows.length - ROWS),
          };
        case "timeline":
          return {
            ...base,
            title: w.title,
            events: w.events.slice(0, ROWS),
            more: Math.max(0, w.events.length - ROWS),
          };
        default:
          return { ...base, ...(w.hidden && { hidden: true }) };
      }
    }),
  };
}

export const officeTools = ({ ports, today }: Ctx) => ({
  caseRead: tool({
    description:
      "Read the case office in full: header, people, every court date with its outcome, tasks, and every widget's " +
      "content. Give widget to read one widget whole (a long note or table the instructions show cut).",
    inputSchema: z.object({ widget: z.string().optional().describe("a widget's id") }),
    execute: async ({ widget }) => {
      const o = await ports.officeRead();
      if (!widget) {
        const all = JSON.stringify({ ...o, today });
        return all.length <= READ_MAX
          ? all
          : `${all.slice(0, READ_MAX)}… [cut: read one widget with caseRead({ widget })]`;
      }
      return o.widgets.find((w) => w.id === widget) ?? `No widget ${widget}. caseRead with no input lists them.`;
    },
  }),
  caseUpdate: tool({
    description:
      "Change the case office: the header, people, court dates (and what happened on one), tasks, and the " +
      "dashboard's widgets (add a note, checklist, table or timeline; update, move, collapse or remove one). " +
      "Several operations in one call are one change the lawyer can undo at once. Name items by the ids the " +
      "case office shows; new items get their ids from the result. Dates are YYYY-MM-DD.",
    inputSchema: z.object({
      summary: z
        .string()
        .max(200)
        .describe("one line for the lawyer: what this change does, e.g. 'Added the trial date 12 Dec and two tasks'"),
      ops: opsSchema,
    }),
    execute: async ({ summary, ops }) => {
      const r = await ports.officeChange(ops, summary);
      if (!r.ok) return `Not changed: ${r.error}`;
      return { changeId: r.changeId, summary: r.summary, office: officeView(r.office, today) };
    },
  }),
});
