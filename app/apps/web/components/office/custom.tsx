"use client";
// The custom widgets the lawyer or the agent adds: a note (markdown), a checklist, a table, a timeline of facts. Each
// edit sends the widget's new content (widget.update); list items keep their ids.
import type { CustomWidget } from "@sllaw/office";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { SafeImg } from "@/components/safe-img";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useOffice } from "./context";
import { EditText, WidgetCard } from "./parts";

type W<T extends CustomWidget["type"]> = Extract<CustomWidget, { type: T }>;

function useUpdate(id: string) {
  const { run } = useOffice();
  return (set: Record<string, unknown>) => run({ op: "widget.update", id, set });
}

function Title({ w }: { w: CustomWidget }) {
  const update = useUpdate(w.id);
  return (
    <EditText
      value={w.title}
      placeholder="Title"
      onSave={(v) => v && update({ title: v })}
      className="text-sm font-medium"
    />
  );
}

export function NoteWidget({ widget: w }: { widget: W<"note"> }) {
  const update = useUpdate(w.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(w.text);
  return (
    <WidgetCard
      widget={w}
      title={w.title}
      by={w.by}
      actions={
        !editing && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Edit ${w.title}`}
            className="text-muted-foreground"
            onClick={() => {
              setText(w.text);
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
        )
      }
    >
      <div className="px-4 pb-4">
        {editing ? (
          <div className="space-y-2">
            <Title w={w} />
            <Textarea aria-label="Note text" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" onClick={async () => (await update({ text })) && setEditing(false)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : w.text.trim() ? (
          <Streamdown className="md max-w-prose text-[0.95rem] leading-relaxed" components={{ img: SafeImg } as never}>
            {w.text}
          </Streamdown>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Write the note: strategy, points to argue, the client's instructions.
          </button>
        )}
      </div>
    </WidgetCard>
  );
}

export function ChecklistWidget({ widget: w }: { widget: W<"checklist"> }) {
  const update = useUpdate(w.id);
  const [text, setText] = useState("");
  const items = w.items;
  const left = items.filter((i) => !i.done).length;
  return (
    <WidgetCard
      widget={w}
      title={w.title}
      count={items.length ? `${left} of ${items.length} left` : undefined}
      by={w.by}
    >
      <ul>
        {items.map((it) => (
          <li key={it.id} className="group flex items-center gap-2.5 border-b border-border/70 py-2">
            <input
              type="checkbox"
              checked={it.done}
              aria-label={it.text}
              onChange={() => update({ items: items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) })}
              className="size-4 shrink-0 cursor-pointer accent-primary"
            />
            <div className={cn("min-w-0 flex-1 text-sm", it.done && "text-muted-foreground line-through")}>
              <EditText
                value={it.text}
                placeholder="Item"
                onSave={(v) => v && update({ items: items.map((x) => (x.id === it.id ? { ...x, text: v } : x)) })}
              />
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${it.text}`}
              className="text-muted-foreground opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              onClick={() => update({ items: items.filter((x) => x.id !== it.id) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await update({ items: [...items, { text, done: false }] }))) setText("");
        }}
      >
        <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          placeholder="Add an item"
          aria-label="New item"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {text.trim() && (
          <Button type="submit" size="xs">
            Add
          </Button>
        )}
      </form>
    </WidgetCard>
  );
}

export function TableWidget({ widget: w }: { widget: W<"table"> }) {
  const update = useUpdate(w.id);
  const [editing, setEditing] = useState(false);
  const [cols, setCols] = useState(w.columns);
  const [rows, setRows] = useState(w.rows);
  const start = () => {
    setCols(w.columns);
    setRows(w.rows.map((r) => w.columns.map((_, i) => r[i] ?? "")));
    setEditing(true);
  };
  const cell = (r: number, c: number, v: string) =>
    setRows(rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  return (
    <WidgetCard
      widget={w}
      title={w.title}
      by={w.by}
      actions={
        !editing && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Edit ${w.title}`}
            className="text-muted-foreground"
            onClick={start}
          >
            <Pencil />
          </Button>
        )
      }
    >
      <div className="overflow-x-auto">
        {editing ? (
          <div className="space-y-2 p-3">
            <Title w={w} />
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {cols.map((c, j) => (
                    <th key={j} className="p-1">
                      <Input
                        aria-label={`Column ${j + 1}`}
                        value={c}
                        onChange={(e) => setCols(cols.map((x, k) => (k === j ? e.target.value : x)))}
                        className="h-8 font-medium"
                      />
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {cols.map((_, j) => (
                      <td key={j} className="p-1">
                        <Input
                          aria-label={`Row ${i + 1}, ${cols[j]}`}
                          value={row[j] ?? ""}
                          onChange={(e) => cell(i, j, e.target.value)}
                          className="h-8"
                        />
                      </td>
                    ))}
                    <td>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove row ${i + 1}`}
                        onClick={() => setRows(rows.filter((_, k) => k !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setRows([...rows, cols.map(() => "")])}>
                <Plus /> Row
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={cols.length >= 8}
                onClick={() => {
                  setCols([...cols, `Column ${cols.length + 1}`]);
                  setRows(rows.map((r) => [...r, ""]));
                }}
              >
                <Plus /> Column
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                onClick={async () =>
                  (await update({ columns: cols.map((c) => c.trim() || "—"), rows })) && setEditing(false)
                }
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : w.rows.length === 0 ? (
          <button
            type="button"
            onClick={start}
            className="px-4 pb-4 text-sm text-muted-foreground hover:text-foreground"
          >
            No rows yet. Add the first one.
          </button>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {w.columns.map((c, j) => (
                  <th key={j} className="px-4 py-2 font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {w.rows.map((row, i) => (
                <tr key={i} className="align-top">
                  {w.columns.map((_, j) => (
                    <td key={j} className={cn("px-4 py-2.5 leading-relaxed", j === 0 && "font-medium")}>
                      {row[j] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </WidgetCard>
  );
}

export function TimelineWidget({ widget: w }: { widget: W<"timeline"> }) {
  const update = useUpdate(w.id);
  const [date, setDate] = useState("");
  const [text, setText] = useState("");
  const events = [...w.events].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <WidgetCard widget={w} title={w.title} count={events.length || undefined} by={w.by}>
      {events.length === 0 && (
        <p className="px-4 pb-2 text-sm text-muted-foreground">The facts in the order they happened.</p>
      )}
      <ol className="px-4 pb-1">
        {events.map((e) => (
          <li key={e.id} className="group relative ml-1.5 flex gap-3 border-l border-foreground/15 py-1.5 pl-4">
            <span className="absolute top-3 -left-[4.5px] size-2 rounded-full border-2 border-card bg-primary" />
            <span className="w-24 shrink-0 text-sm font-semibold tabular-nums">{e.date}</span>
            <div className="min-w-0 flex-1 text-sm">
              <EditText
                value={e.text}
                placeholder="What happened"
                onSave={(v) => v && update({ events: w.events.map((x) => (x.id === e.id ? { ...x, text: v } : x)) })}
              />
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${e.date}`}
              className="text-muted-foreground opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              onClick={() => update({ events: w.events.filter((x) => x.id !== e.id) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ol>
      <form
        className="flex gap-2 border-t px-4 py-2.5"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (date.trim() && text.trim() && (await update({ events: [...w.events, { date, text }] }))) {
            setDate("");
            setText("");
          }
        }}
      >
        <Input
          placeholder="2024-03-01"
          aria-label="Event date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 w-28"
        />
        <Input
          placeholder="What happened"
          aria-label="Event"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-8 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={!date.trim() || !text.trim()} aria-label="Add event">
          <Plus />
        </Button>
      </form>
    </WidgetCard>
  );
}
