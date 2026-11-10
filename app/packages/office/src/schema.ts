// The case office (docs/APP.md, Case office): one JSON document per case holding its header, people, court dates,
// tasks and the dashboard's widgets. One schema checks every saved document, whoever wrote it (the lawyer's page or
// the agent's tool): a widget outside the catalog or a field out of shape is refused and the saved one stays.
import { z } from "zod";

export const BY = ["lawyer", "ai"] as const;
export type By = (typeof BY)[number];

export const SIDES = [
  "plaintiff",
  "defendant",
  "petitioner",
  "respondent",
  "appellant",
  "accused",
  "complainant",
  "intervenient",
  "other",
] as const;
export const STAGES = [
  "before filing",
  "pleadings",
  "pre-trial",
  "trial",
  "judgment",
  "appeal",
  "execution",
  "closed",
] as const;
export const ROLES = [
  "client",
  "opposing_party",
  "opposing_counsel",
  "instructing_attorney",
  "judge",
  "witness",
  "other",
] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const id = z.string().min(1).max(40);
const short = (max = 200) => z.string().trim().max(max);
const by = z.enum(BY);

export const HEADER_FIELDS = ["court", "caseNumber", "kind", "side", "stage", "client"] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

export const headerSchema = z.object({
  court: short(),
  caseNumber: short(100),
  kind: short(100), // land, partition, money recovery, divorce, criminal, writ, fundamental rights ...
  side: z.union([z.enum(SIDES), z.literal("")]),
  stage: z.union([z.enum(STAGES), z.literal("")]),
  client: short(),
  by: z.partialRecord(z.enum(HEADER_FIELDS), by), // who last set each field
});

export const personSchema = z.object({
  id,
  name: short().min(1),
  role: z.enum(ROLES),
  phone: short(60),
  email: short(200),
  note: short(1000),
  by,
});

export const courtDateSchema = z.object({
  id,
  date: day,
  court: short(),
  purpose: short(200), // calling, answer, trial, further trial, written submissions, judgment ...
  outcome: z.string().trim().max(2000).nullable(), // what happened on the day; null until recorded
  by,
});

export const taskSchema = z.object({
  id,
  title: short(300).min(1),
  due: day.nullable(),
  done: z.boolean(),
  by,
});

// ---- widgets ----

export const CORE = ["header", "next_date", "tasks", "journal", "people"] as const;
export type CoreType = (typeof CORE)[number];
export const CUSTOM = ["note", "checklist", "table", "timeline"] as const;
export type CustomType = (typeof CUSTOM)[number];

const widgetBase = { id, collapsed: z.boolean() };
const title = short(120).min(1);

const coreWidget = z.object({ ...widgetBase, type: z.enum(CORE), hidden: z.boolean() });
// The custom widgets' content: what the lawyer or the agent puts in them.
export const noteContent = z.object({ title, text: z.string().max(20_000) });
export const checklistContent = z.object({
  title,
  items: z.array(z.object({ id, text: short(500).min(1), done: z.boolean() })).max(200),
});
export const tableContent = z.object({
  title,
  columns: z.array(short(80).min(1)).min(1).max(8),
  rows: z.array(z.array(z.string().max(1000)).max(8)).max(200),
});
export const timelineContent = z.object({
  title,
  events: z.array(z.object({ id, date: short(20), text: short(1000).min(1) })).max(200),
});

export const widgetSchema = z.discriminatedUnion("type", [
  coreWidget.extend({ type: z.literal("header") }),
  coreWidget.extend({ type: z.literal("next_date") }),
  coreWidget.extend({ type: z.literal("tasks") }),
  coreWidget.extend({ type: z.literal("journal") }),
  coreWidget.extend({ type: z.literal("people") }),
  z.object({ ...widgetBase, type: z.literal("note"), by, ...noteContent.shape }),
  z.object({ ...widgetBase, type: z.literal("checklist"), by, ...checklistContent.shape }),
  z.object({ ...widgetBase, type: z.literal("table"), by, ...tableContent.shape }),
  z.object({ ...widgetBase, type: z.literal("timeline"), by, ...timelineContent.shape }),
]);

// a whole office, as JSON: every write rewrites it and the agent reads it (security review, 2026-11-11)
export const MAX_DOC = 1_000_000;

export const officeSchema = z
  .object({
    header: headerSchema,
    people: z.array(personSchema).max(200),
    dates: z.array(courtDateSchema).max(500),
    tasks: z.array(taskSchema).max(500),
    widgets: z.array(widgetSchema).max(40),
  })
  .superRefine((o, ctx) => {
    if (JSON.stringify(o).length > MAX_DOC)
      ctx.addIssue({
        code: "custom",
        message: "the case page is full: remove some notes, rows or old tasks",
        path: [],
      });
    for (const t of CORE)
      if (o.widgets.filter((w) => w.type === t).length !== 1)
        ctx.addIssue({ code: "custom", message: `the ${t} widget must be there exactly once`, path: ["widgets"] });
    const ids = o.widgets.map((w) => w.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "widget ids repeat", path: ["widgets"] });
    o.widgets.forEach((w, i) => {
      if (w.type === "table" && w.rows.some((r) => r.length > w.columns.length))
        ctx.addIssue({ code: "custom", message: "a table row has more cells than columns", path: ["widgets", i] });
    });
  });

export type Header = z.infer<typeof headerSchema>;
export type Person = z.infer<typeof personSchema>;
export type CourtDate = z.infer<typeof courtDateSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Widget = z.infer<typeof widgetSchema>;
export type CustomWidget = Extract<Widget, { type: CustomType }>;
export type Office = z.infer<typeof officeSchema>;

export const isCore = (w: Widget): w is Extract<Widget, { type: CoreType }> =>
  (CORE as readonly string[]).includes(w.type);

/** A case's office before anyone has written to it: an empty header and the core widgets in their default order. */
export function defaultWidgets(): Widget[] {
  return CORE.map((type) => ({ id: type, type, collapsed: false, hidden: false }));
}
export function emptyOffice(): Office {
  return {
    header: { court: "", caseNumber: "", kind: "", side: "", stage: "", client: "", by: {} },
    people: [],
    dates: [],
    tasks: [],
    widgets: defaultWidgets(),
  };
}
