// Changes to a case office: one list of operations for the lawyer's page and the agent's tool alike. `apply` runs them
// on a copy, checks the result against the schema and returns what changed, item by item (`Item`: before and after).
import { z } from "zod";
import {
  type By,
  type CUSTOM,
  checklistContent,
  defaultWidgets,
  HEADER_FIELDS,
  type HeaderField,
  isCore,
  noteContent,
  type Office,
  officeSchema,
  ROLES,
  SIDES,
  STAGES,
  tableContent,
  timelineContent,
  type Widget,
} from "./schema";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const id = z.string().min(1).max(40);
const text = (max: number) => z.string().trim().max(max);

const personInput = z.object({
  name: text(200).min(1),
  role: z.enum(ROLES),
  phone: text(60).optional(),
  email: text(200).optional(),
  note: text(1000).optional(),
});
const dateInput = z.object({ date: day, court: text(200).optional(), purpose: text(200).optional() });
const itemId = id.optional().describe("leave out for a new item");
// custom widget content as given: list items and events may come without ids (new ones get one)
const contentIn = {
  note: noteContent,
  checklist: checklistContent.extend({
    items: z.array(z.object({ id: itemId, text: text(500).min(1), done: z.boolean().optional() })).max(200),
  }),
  table: tableContent,
  timeline: timelineContent.extend({
    events: z.array(z.object({ id: itemId, date: text(20), text: text(1000).min(1) })).max(200),
  }),
};
const widgetIn = z.discriminatedUnion("type", [
  contentIn.note.extend({ type: z.literal("note") }),
  contentIn.checklist.extend({ type: z.literal("checklist") }),
  contentIn.table.extend({ type: z.literal("table") }),
  contentIn.timeline.extend({ type: z.literal("timeline") }),
]);
const widgetSet = z
  .object({
    title: noteContent.shape.title,
    text: noteContent.shape.text,
    items: contentIn.checklist.shape.items,
    columns: tableContent.shape.columns,
    rows: tableContent.shape.rows,
    events: contentIn.timeline.shape.events,
  })
  .partial();

export const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("header.set"),
    set: z
      .object({
        court: text(200),
        caseNumber: text(100),
        kind: text(100),
        side: z.union([z.enum(SIDES), z.literal("")]),
        stage: z.union([z.enum(STAGES), z.literal("")]),
        client: text(200),
      })
      .partial(),
  }),
  z.object({ op: z.literal("person.add"), person: personInput }),
  z.object({ op: z.literal("person.update"), id, set: personInput.partial() }),
  z.object({ op: z.literal("person.remove"), id }),
  z.object({ op: z.literal("date.add"), ...dateInput.shape }),
  z.object({
    op: z.literal("date.update"),
    id,
    set: dateInput.extend({ outcome: text(2000).nullable() }).partial(),
  }),
  z.object({ op: z.literal("date.remove"), id }),
  z.object({
    op: z.literal("date.outcome"),
    id,
    outcome: text(2000).min(1),
    next: dateInput.optional().describe("the next date the court gave, and what it is for"),
  }),
  z.object({ op: z.literal("task.add"), title: text(300).min(1), due: day.nullish() }),
  z.object({
    op: z.literal("task.update"),
    id,
    set: z.object({ title: text(300).min(1), due: day.nullable(), done: z.boolean() }).partial(),
  }),
  z.object({ op: z.literal("task.remove"), id }),
  z.object({
    op: z.literal("widget.add"),
    widget: widgetIn,
    at: z.number().int().min(0).optional().describe("position in the dashboard, from 0; leave out for the end"),
  }),
  z.object({ op: z.literal("widget.update"), id, set: widgetSet }),
  z.object({ op: z.literal("widget.move"), id, to: z.number().int().min(0) }),
  z.object({ op: z.literal("widget.collapse"), id, collapsed: z.boolean() }),
  z.object({ op: z.literal("widget.hide"), id, hidden: z.boolean() }),
  z.object({ op: z.literal("widget.remove"), id }),
  z.object({ op: z.literal("layout.reset") }),
]);
export type Op = z.infer<typeof opSchema>;
export const opsSchema = z.array(opSchema).min(1).max(50);

/** A change that cannot be made: the message says why, in words the lawyer or the model can act on. */
export class OfficeError extends Error {}

// ---- what changed ----

/** One item a change touched: `key` is "header", "order" (the widgets' order), or "<person|date|task|widget>:<id>";
 *  before or after is null when the item did not exist. */
export type Item = { key: string; before: unknown; after: unknown };

const COLLECTIONS = { person: "people", date: "dates", task: "tasks", widget: "widgets" } as const;
type Coll = keyof typeof COLLECTIONS;
// key order does not matter (the schema's parse reorders keys)
const stable = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(stable).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(x);
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

export function diff(before: Office, after: Office): Item[] {
  const items: Item[] = [];
  if (!same(before.header, after.header)) items.push({ key: "header", before: before.header, after: after.header });
  for (const [kind, field] of Object.entries(COLLECTIONS) as [Coll, (typeof COLLECTIONS)[Coll]][]) {
    const was = new Map<string, unknown>(before[field].map((x) => [x.id, x]));
    const now = new Map<string, unknown>(after[field].map((x) => [x.id, x]));
    for (const k of new Set([...was.keys(), ...now.keys()])) {
      const b = was.get(k) ?? null;
      const a = now.get(k) ?? null;
      if (!same(b, a)) items.push({ key: `${kind}:${k}`, before: b, after: a });
    }
  }
  const order = (o: Office) => o.widgets.map((w) => w.id);
  if (!same(order(before), order(after))) items.push({ key: "order", before: order(before), after: order(after) });
  return items;
}

function check(o: Office): Office {
  const r = officeSchema.safeParse(o);
  if (!r.success) throw new OfficeError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

// ---- applying ----

export type NewId = () => string;
export const newId: NewId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

/** Runs the operations in order on a copy of the office, as `by`. Throws OfficeError (nothing applied) when one
 *  names an item that is not there, would leave a core widget hidden by the agent or removed by anyone, or the result
 *  breaks the schema. */
export function apply(office: Office, ops: Op[], by: By, mint: NewId = newId): { office: Office; items: Item[] } {
  const o = structuredClone(office);
  for (const op of ops) step(o, op, by, mint);
  const next = check(o);
  return { office: next, items: diff(office, next) };
}

function find<T extends { id: string }>(list: T[], itemId: string, what: string): T {
  const x = list.find((i) => i.id === itemId);
  if (!x) throw new OfficeError(`No ${what} with id ${itemId}.`);
  return x;
}
const drop = <T extends { id: string }>(list: T[], itemId: string, what: string) => {
  find(list, itemId, what);
  return list.filter((i) => i.id !== itemId);
};
const defined = <T extends object>(x: T) =>
  Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<T>;

const CONTENT_KEYS: Record<(typeof CUSTOM)[number], string[]> = {
  note: ["title", "text"],
  checklist: ["title", "items"],
  table: ["title", "columns", "rows"],
  timeline: ["title", "events"],
};

function withIds<T extends { id?: string }>(xs: T[], mint: NewId) {
  return xs.map((x) => ({ ...x, id: x.id || mint() }));
}

function step(o: Office, op: Op, by: By, mint: NewId) {
  switch (op.op) {
    case "header.set": {
      const set = defined(op.set);
      Object.assign(o.header, set);
      for (const k of Object.keys(set))
        if ((HEADER_FIELDS as readonly string[]).includes(k)) o.header.by[k as HeaderField] = by;
      return;
    }
    case "person.add":
      o.people.push({ phone: "", email: "", note: "", ...op.person, id: mint(), by });
      return;
    case "person.update":
      Object.assign(find(o.people, op.id, "person"), defined(op.set), { by });
      return;
    case "person.remove":
      o.people = drop(o.people, op.id, "person");
      return;
    case "date.add":
      o.dates.push({ id: mint(), date: op.date, court: op.court ?? "", purpose: op.purpose ?? "", outcome: null, by });
      return;
    case "date.update":
      Object.assign(find(o.dates, op.id, "court date"), defined(op.set), { by });
      return;
    case "date.remove":
      o.dates = drop(o.dates, op.id, "court date");
      return;
    case "date.outcome": {
      const d = find(o.dates, op.id, "court date");
      Object.assign(d, { outcome: op.outcome, by });
      if (op.next)
        o.dates.push({
          id: mint(),
          date: op.next.date,
          court: op.next.court ?? d.court,
          purpose: op.next.purpose ?? "",
          outcome: null,
          by,
        });
      return;
    }
    case "task.add":
      o.tasks.push({ id: mint(), title: op.title, due: op.due ?? null, done: false, by });
      return;
    case "task.update":
      Object.assign(find(o.tasks, op.id, "task"), defined(op.set), { by });
      return;
    case "task.remove":
      o.tasks = drop(o.tasks, op.id, "task");
      return;
    case "widget.add": {
      const w = op.widget;
      const base = { id: mint(), collapsed: false, by };
      const made: Widget =
        w.type === "checklist"
          ? { ...base, ...w, items: withIds(w.items, mint).map((i) => ({ ...i, done: i.done ?? false })) }
          : w.type === "timeline"
            ? { ...base, ...w, events: withIds(w.events, mint) }
            : { ...base, ...w };
      o.widgets.splice(op.at ?? o.widgets.length, 0, made);
      return;
    }
    case "widget.update": {
      const w = find(o.widgets, op.id, "widget");
      if (isCore(w)) throw new OfficeError(`${w.type} is a core widget: change its data, not the widget.`);
      const set = defined(op.set);
      const bad = Object.keys(set).filter((k) => !CONTENT_KEYS[w.type].includes(k));
      if (bad.length)
        throw new OfficeError(
          `A ${w.type} widget has no ${bad.join(", ")} (it has ${CONTENT_KEYS[w.type].join(", ")}).`,
        );
      if (set.items) set.items = withIds(set.items, mint).map((i) => ({ ...i, done: i.done ?? false }));
      if (set.events) set.events = withIds(set.events, mint);
      Object.assign(w, set, { by });
      return;
    }
    case "widget.move": {
      const w = find(o.widgets, op.id, "widget");
      o.widgets = o.widgets.filter((x) => x.id !== op.id);
      o.widgets.splice(Math.min(op.to, o.widgets.length), 0, w);
      return;
    }
    case "widget.collapse":
      find(o.widgets, op.id, "widget").collapsed = op.collapsed;
      return;
    case "widget.hide": {
      const w = find(o.widgets, op.id, "widget");
      if (!isCore(w)) throw new OfficeError("Only a core widget is hidden; remove a custom widget instead.");
      // the agent may not hide what the lawyer relies on (a file's text could ask it to; brief case-office)
      if (op.hidden && by === "ai")
        throw new OfficeError(`The ${w.type} widget is pinned: only the lawyer can hide it.`);
      w.hidden = op.hidden;
      return;
    }
    case "widget.remove": {
      const w = find(o.widgets, op.id, "widget");
      if (isCore(w))
        throw new OfficeError(
          by === "ai"
            ? `The ${w.type} widget is pinned: it cannot be removed.`
            : `${w.type} is a core widget: hide it instead.`,
        );
      o.widgets = o.widgets.filter((x) => x.id !== op.id);
      return;
    }
    case "layout.reset":
      o.widgets = defaultWidgets();
      return;
  }
}

// ---- in words ----

const LABEL: Record<string, string> = {
  court: "court",
  caseNumber: "case number",
  kind: "kind of case",
  side: "our side",
  stage: "stage",
  client: "client",
};

/** One line saying what the operations do, for the history and the chat card when no summary is given. */
export function describe(ops: Op[], office: Office): string {
  const name = (list: { id: string }[], itemId: string, f: (x: any) => string) => {
    const x = list.find((i) => i.id === itemId);
    return x ? f(x) : itemId;
  };
  const one = (op: Op): string => {
    switch (op.op) {
      case "header.set":
        return `Set ${Object.keys(defined(op.set))
          .map((k) => LABEL[k])
          .join(", ")}`;
      case "person.add":
        return `Added ${op.person.name} (${op.person.role.replace(/_/g, " ")})`;
      case "person.update":
        return `Updated ${name(office.people, op.id, (p) => p.name)}`;
      case "person.remove":
        return `Removed ${name(office.people, op.id, (p) => p.name)}`;
      case "date.add":
        return `Added court date ${op.date}${op.purpose ? ` (${op.purpose})` : ""}`;
      case "date.update":
        return `Changed court date ${name(office.dates, op.id, (d) => d.date)}`;
      case "date.remove":
        return `Removed court date ${name(office.dates, op.id, (d) => d.date)}`;
      case "date.outcome":
        return `Recorded ${name(office.dates, op.id, (d) => d.date)}${op.next ? `; next date ${op.next.date}` : ""}`;
      case "task.add":
        return `Added task "${op.title}"`;
      case "task.update":
        return op.set.done !== undefined && Object.keys(defined(op.set)).length === 1
          ? `${op.set.done ? "Done" : "Reopened"}: "${name(office.tasks, op.id, (t) => t.title)}"`
          : `Updated task "${name(office.tasks, op.id, (t) => t.title)}"`;
      case "task.remove":
        return `Removed task "${name(office.tasks, op.id, (t) => t.title)}"`;
      case "widget.add":
        return `Added ${op.widget.type} "${op.widget.title}"`;
      case "widget.update":
        return `Updated "${name(office.widgets, op.id, (w) => w.title ?? w.type)}"`;
      case "widget.move":
        return `Moved "${name(office.widgets, op.id, (w) => w.title ?? w.type)}"`;
      case "widget.collapse":
        return `${op.collapsed ? "Collapsed" : "Opened"} "${name(office.widgets, op.id, (w) => w.title ?? w.type)}"`;
      case "widget.hide":
        return `${op.hidden ? "Hid" : "Showed"} ${op.id.replace(/_/g, " ")}`;
      case "widget.remove":
        return `Removed "${name(office.widgets, op.id, (w) => w.title ?? w.type)}"`;
      case "layout.reset":
        return "Reset the dashboard to default";
    }
  };
  const lines = ops.map(one);
  return lines.length <= 3 ? lines.join("; ") : `${lines.slice(0, 3).join("; ")} and ${lines.length - 3} more`;
}
