"use client";
// The core widgets, always on the case (the lawyer may hide them, the agent may not). The cover band: the docket
// cover (case number, title, court, kind, our side, stage, client) and the next date as a diary leaf, with a slip
// asking "What happened on <date>?" for each past date. The record: the journal as a diary ledger. The rail: tasks
// and people.
import {
  awaitingOutcome,
  type By,
  type CourtDate,
  journal,
  nextDate,
  overdue,
  type Person,
  ROLES,
  SIDES,
  STAGES,
  sortedTasks,
  type Widget,
} from "@sllaw/office";
import { Loader2, Mail, Phone, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { daysFrom, leaf } from "@/lib/office";
import { cn } from "@/lib/utils";
import { useOffice } from "./context";
import { AiMark, DateChip, EditText, fmtDay, label, selectClass, WidgetCard, WidgetMenu, whenLabel } from "./parts";

// ---- the docket cover ----

function Field({ by, title, children }: { by?: By; title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {title} <AiMark by={by} />
      </dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

function Choice({
  value,
  options,
  onChange,
  aria,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  aria: string;
}) {
  return (
    <select
      aria-label={aria}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "-mx-1 max-w-full cursor-pointer appearance-none rounded bg-transparent px-1 text-sm outline-none hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring",
        !value && "text-muted-foreground/80 italic",
      )}
    >
      <option value="">Add</option>
      {options.map((s) => (
        <option key={s} value={s}>
          {label(s)}
        </option>
      ))}
    </select>
  );
}

export function HeaderWidget({ widget, title }: { widget: Widget; title: string }) {
  const { office, run } = useOffice();
  const h = office.header;
  const set = (field: string, v: string) => run({ op: "header.set", set: { [field]: v } });
  return (
    <section
      aria-label="Case details"
      className="relative h-full overflow-hidden rounded-lg border bg-card shadow-2xs before:absolute before:inset-y-0 before:left-0 before:w-1.5 before:bg-primary"
    >
      <div className="py-5 pr-3 pl-7 sm:pr-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <EditText
                label="Case number"
                value={h.caseNumber}
                placeholder="Add the case number"
                onSave={(v) => set("caseNumber", v)}
                className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl"
                inputClassName="h-10 text-xl"
              />
              <AiMark by={h.by.caseNumber} />
            </div>
            <h1 className="mt-1 text-base text-balance text-foreground/75">{title}</h1>
          </div>
          <WidgetMenu widget={widget} title="Case details" />
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3">
          <Field by={h.by.court} title="Court">
            <EditText label="Court" value={h.court} placeholder="Add" onSave={(v) => set("court", v)} />
          </Field>
          <Field by={h.by.kind} title="Kind of case">
            <EditText label="Kind of case" value={h.kind} placeholder="Add" onSave={(v) => set("kind", v)} />
          </Field>
          <Field by={h.by.client} title="Client">
            <EditText label="Client" value={h.client} placeholder="Add" onSave={(v) => set("client", v)} />
          </Field>
          <Field by={h.by.side} title="We appear for the">
            <Choice aria="Our side" value={h.side} options={SIDES} onChange={(v) => set("side", v)} />
          </Field>
          <Field by={h.by.stage} title="Stage">
            <Choice aria="Stage" value={h.stage} options={STAGES} onChange={(v) => set("stage", v)} />
          </Field>
        </dl>
      </div>
    </section>
  );
}

// ---- the next date: a diary leaf ----

function DateForm({ onDone, court }: { onDone: () => void; court: string }) {
  const { run } = useOffice();
  const [date, setDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [c, setC] = useState(court);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (date && (await run({ op: "date.add", date, court: c, purpose }))) onDone();
      }}
    >
      <Input
        type="date"
        aria-label="Date"
        required
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="h-8"
      />
      <Input
        placeholder="For: trial, answer, calling…"
        aria-label="Purpose"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        className="h-8"
      />
      <Input placeholder="Court" aria-label="Court" value={c} onChange={(e) => setC(e.target.value)} className="h-8" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!date}>
          Add date
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "What happened on <date>?": the outcome and the next date the court gave. */
function OutcomeSlip({ d }: { d: CourtDate }) {
  const { run } = useOffice();
  const [outcome, setOutcome] = useState("");
  const [next, setNext] = useState("");
  const [purpose, setPurpose] = useState("");
  return (
    <form
      className="space-y-2 border-t border-dashed border-unverified-border bg-unverified px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (outcome.trim())
          run({ op: "date.outcome", id: d.id, outcome, ...(next && { next: { date: next, purpose } }) });
      }}
    >
      <p className="text-sm">
        <span className="font-medium">What happened on {fmtDay(d.date)}?</span>
        {d.purpose && <span className="block text-xs text-muted-foreground">{label(d.purpose)}</span>}
      </p>
      <Textarea
        aria-label="What happened"
        placeholder="Trial postponed: the court did not sit."
        rows={2}
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        className="bg-background"
      />
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Input
          type="date"
          aria-label="Next date"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="h-8 bg-background"
        />
        <Input
          placeholder="Next date is for…"
          aria-label="Next date is for"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className="h-8 bg-background"
        />
      </div>
      <Button type="submit" size="sm" disabled={!outcome.trim()}>
        Record
      </Button>
    </form>
  );
}

export function NextDateWidget({ widget }: { widget: Widget }) {
  const { office, today } = useOffice();
  const [adding, setAdding] = useState(false);
  const next = nextDate(office, today);
  const waiting = awaitingOutcome(office, today);
  const l = next && leaf(next.date);
  const n = next ? daysFrom(today, next.date) : null;
  return (
    <section aria-label="Next date" className="h-full overflow-hidden rounded-lg border bg-card shadow-2xs">
      <div className="h-1.5 bg-primary" aria-hidden />
      <div className="flex items-center justify-between gap-1 pt-2 pr-2 pl-4">
        <h2 className="text-xs text-muted-foreground">Next date</h2>
        <div className="flex items-center">
          <AiMark by={next?.by} className="mr-1" />
          {!adding && (
            <Button size="icon-sm" variant="ghost" aria-label="Add a court date" onClick={() => setAdding(true)}>
              <Plus />
            </Button>
          )}
          <WidgetMenu widget={widget} title="Next date" />
        </div>
      </div>
      <div className="px-4 pb-4">
        {adding ? (
          <div className="pt-1">
            <DateForm court={office.header.court} onDone={() => setAdding(false)} />
          </div>
        ) : next && l ? (
          <>
            <div className="flex items-start gap-4">
              <div className="text-6xl leading-[0.85] font-semibold tracking-tight tabular-nums">{l.day}</div>
              <div className="min-w-0">
                <div className="text-lg leading-tight font-semibold">
                  {l.month} {l.year}
                </div>
                <div className="text-sm text-muted-foreground">{l.weekday}</div>
                <div
                  className={cn(
                    "mt-1 text-sm font-medium",
                    n === 0 ? "text-destructive" : n !== null && n <= 7 ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {whenLabel(today, next.date)}
                </div>
              </div>
            </div>
            {(next.purpose || next.court) && (
              <div className="mt-3 border-t pt-2.5 text-sm">
                {next.purpose && <div className="font-medium">{label(next.purpose)}</div>}
                {next.court && <div className="text-muted-foreground">{next.court}</div>}
              </div>
            )}
          </>
        ) : (
          <div className="pt-1">
            <p className="text-lg">No date ahead</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setAdding(true)}>
              <Plus /> Add the next date
            </Button>
          </div>
        )}
      </div>
      {waiting.map((d) => (
        <OutcomeSlip key={d.id} d={d} />
      ))}
    </section>
  );
}

// ---- the journal: a diary ledger ----

export function JournalWidget({ widget }: { widget: Widget }) {
  const { office, today, run } = useOffice();
  const dates = journal(office);
  return (
    <WidgetCard widget={widget} title="Journal" count={dates.length || undefined}>
      {dates.length === 0 ? (
        <p className="px-4 pb-5 text-sm text-muted-foreground">
          Every date the case is called, with what happened. Add one from Next date.
        </p>
      ) : (
        <ol className="pb-1">
          {dates.map((d) => {
            const l = leaf(d.date);
            const ahead = d.date >= today;
            const open = !ahead && d.outcome == null;
            return (
              <li key={d.id} className="group grid grid-cols-[4rem_1fr_auto] border-t">
                <div className={cn("border-r py-2.5 pr-3 text-right", ahead && "text-primary")}>
                  <div className="text-xl leading-none font-semibold tabular-nums">{l.day}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {l.month}
                    {l.year !== today.slice(0, 4) && ` ${l.year}`}
                  </div>
                </div>
                <div className="min-w-0 py-2.5 pl-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{d.purpose ? label(d.purpose) : "Court date"}</span>
                    {d.court && <span className="text-xs text-muted-foreground">{d.court}</span>}
                    <AiMark by={d.by} className="self-center" />
                  </div>
                  {ahead ? (
                    <div className="text-xs text-primary">{whenLabel(today, d.date)}</div>
                  ) : (
                    <EditText
                      multiline
                      label={`What happened on ${fmtDay(d.date)}`}
                      value={d.outcome ?? ""}
                      placeholder={open ? "No outcome recorded yet" : "What happened?"}
                      onSave={(v) => run({ op: "date.update", id: d.id, set: { outcome: v || null } })}
                      className={cn(
                        "mt-0.5 block leading-relaxed",
                        open ? "text-unverified-ink" : "text-foreground/80",
                      )}
                    />
                  )}
                </div>
                <div className="py-2 pr-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${fmtDay(d.date)}`}
                    className="text-muted-foreground opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    onClick={() => run({ op: "date.remove", id: d.id })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </WidgetCard>
  );
}

// ---- tasks ----

export function TasksWidget({ widget }: { widget: Widget }) {
  const { office, today, run } = useOffice();
  const { open, done } = sortedTasks(office);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const late = open.filter((t) => overdue(t, today)).length;
  return (
    <WidgetCard
      widget={widget}
      title="Tasks"
      count={late ? <span className="text-destructive">{late} overdue</span> : open.length || undefined}
    >
      <ul>
        {[...open, ...(showDone ? done : [])].map((t) => (
          <li key={t.id} className="group flex items-start gap-2.5 border-b border-border/70 py-2">
            <input
              type="checkbox"
              checked={t.done}
              aria-label={t.done ? `Reopen: ${t.title}` : `Done: ${t.title}`}
              onChange={() => run({ op: "task.update", id: t.id, set: { done: !t.done } })}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            />
            <div className={cn("min-w-0 flex-1 text-sm leading-snug", t.done && "text-muted-foreground line-through")}>
              <EditText
                label="Task"
                value={t.title}
                placeholder="Task"
                onSave={(v) => v && run({ op: "task.update", id: t.id, set: { title: v } })}
              />
              <AiMark by={t.by} className="ml-1 align-middle" />
            </div>
            <DateChip
              label={`Due: ${t.title}`}
              value={t.due}
              tone={overdue(t, today) ? "late" : t.due && !t.done && daysFrom(today, t.due) <= 2 ? "soon" : undefined}
              onChange={(v) => run({ op: "task.update", id: t.id, set: { due: v } })}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete: ${t.title}`}
              className="text-muted-foreground opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              onClick={() => run({ op: "task.remove", id: t.id })}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (title.trim() && (await run({ op: "task.add", title, due }))) {
            setTitle("");
            setDue(null);
          }
        }}
      >
        <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          placeholder="Add a task"
          aria-label="New task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {title.trim() && (
          <>
            <DateChip label="Due" value={due} onChange={setDue} />
            <Button type="submit" size="xs">
              Add
            </Button>
          </>
        )}
      </form>
      {done.length > 0 && (
        <button
          type="button"
          onClick={() => setShowDone(!showDone)}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {showDone ? "Hide done tasks" : `${done.length} done`}
        </button>
      )}
    </WidgetCard>
  );
}

// ---- people ----

function PersonForm({ p, onDone }: { p?: Person; onDone: () => void }) {
  const { run, pending } = useOffice();
  const [f, setF] = useState({
    name: p?.name ?? "",
    role: p?.role ?? ("client" as Person["role"]),
    phone: p?.phone ?? "",
    email: p?.email ?? "",
    note: p?.note ?? "",
  });
  const bind = (k: keyof typeof f) => ({
    value: f[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF({ ...f, [k]: e.target.value }),
  });
  return (
    <form
      className="grid gap-2 border-b py-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!f.name.trim()) return;
        const ok = p
          ? await run({ op: "person.update", id: p.id, set: f })
          : await run({ op: "person.add", person: f });
        if (ok) onDone();
      }}
    >
      <Input placeholder="Name" aria-label="Name" required {...bind("name")} className="h-8" />
      <select aria-label="Role" className={selectClass} {...bind("role")}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {label(r)}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="Phone" aria-label="Phone" type="tel" {...bind("phone")} className="h-8" />
        <Input placeholder="Email" aria-label="Email" type="email" {...bind("email")} className="h-8" />
      </div>
      <Textarea placeholder="Note" aria-label="Note" rows={2} {...bind("note")} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {p ? "Save" : "Add person"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {p && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            onClick={() => run({ op: "person.remove", id: p.id })}
          >
            <Trash2 /> Remove
          </Button>
        )}
      </div>
    </form>
  );
}

export function PeopleWidget({ widget }: { widget: Widget }) {
  const { office } = useOffice();
  const [editing, setEditing] = useState<string | null>(null); // a person's id, or "new"
  const people = [...office.people].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  return (
    <WidgetCard
      widget={widget}
      title="People"
      count={people.length || undefined}
      actions={
        editing !== "new" && (
          <Button size="icon-sm" variant="ghost" aria-label="Add a person" onClick={() => setEditing("new")}>
            <Plus />
          </Button>
        )
      }
    >
      {editing === "new" && <PersonForm onDone={() => setEditing(null)} />}
      {people.length === 0 && editing !== "new" && (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="py-2 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          Add the client, the other side, counsel, the judge.
        </button>
      )}
      <ul>
        {people.map((p) =>
          editing === p.id ? (
            <li key={p.id}>
              <PersonForm p={p} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={p.id} className="border-b border-border/70 py-2 text-sm">
              <div className="flex items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(p.id)}
                  className="min-w-0 truncate rounded text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {p.name}
                </button>
                <AiMark by={p.by} className="self-center" />
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label(p.role)}</span>
              </div>
              {(p.phone || p.email) && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {p.phone && (
                    <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 hover:text-foreground">
                      <Phone className="size-3" /> {p.phone}
                    </a>
                  )}
                  {p.email && (
                    <a
                      href={`mailto:${p.email}`}
                      className="inline-flex min-w-0 items-center gap-1 hover:text-foreground"
                    >
                      <Mail className="size-3 shrink-0" /> <span className="truncate">{p.email}</span>
                    </a>
                  )}
                </div>
              )}
              {p.note && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.note}</p>}
            </li>
          ),
        )}
      </ul>
    </WidgetCard>
  );
}
