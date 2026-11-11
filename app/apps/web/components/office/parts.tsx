"use client";
// Pieces every widget uses: its frame (a panel in the main column, a plain list in the rail), the AI's mark, text
// edited in place, and a date that reads "28 Nov" and opens the picker on click.
import type { By, Widget } from "@sllaw/office";
import { isCore } from "@sllaw/office";
import { ArrowDown, ArrowUp, CalendarPlus, ChevronDown, EyeOff, MoreHorizontal, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtShort, zoneOf } from "@/lib/office";
import { cn } from "@/lib/utils";
import { useOffice } from "./context";

export { daysFrom, fmtDay, fmtShort, label, whenLabel } from "@/lib/office";

/** What the agent wrote: a small sparkle. */
export function AiMark({ by, className }: { by?: By; className?: string }) {
  if (by !== "ai") return null;
  return (
    <span title="Written by the AI." className={cn("inline-flex shrink-0 text-primary/70", className)}>
      <Sparkles className="size-3" aria-hidden />
      <span className="sr-only">(by AI)</span>
    </span>
  );
}

/** Text that turns into a field on click; Enter or leaving the field saves, Escape cancels. */
export function EditText({
  value,
  placeholder,
  onSave,
  multiline,
  className,
  inputClassName,
  label: aria,
}: {
  value: string;
  placeholder: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (v.trim() !== value.trim()) onSave(v.trim());
  };
  if (!editing)
    return (
      <button
        type="button"
        aria-label={aria ? `${aria}: ${value || "not set"}` : undefined}
        onClick={() => setEditing(true)}
        className={cn(
          "-mx-1 min-w-0 rounded px-1 text-left decoration-dotted underline-offset-4 transition-colors hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring",
          !value && "text-muted-foreground/80 italic",
          multiline && "whitespace-pre-wrap",
          className,
        )}
      >
        {value || placeholder}
      </button>
    );
  const props = {
    ref,
    value: v,
    placeholder,
    "aria-label": aria ?? placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: save,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setV(value);
        setEditing(false);
      }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) save();
    },
  };
  return multiline ? (
    <Textarea {...props} rows={4} className={inputClassName} />
  ) : (
    <Input {...props} className={cn("h-8", inputClassName)} />
  );
}

/** A date as "28 Nov" (or a calendar icon when there is none); a click opens the browser's date picker. */
export function DateChip({
  value,
  onChange,
  label: aria,
  tone,
  className,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
  tone?: "late" | "soon";
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = ref.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        onClick={open}
        aria-label={`${aria}: ${value ? fmtShort(value) : "no date"}`}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs tabular-nums transition-colors hover:bg-accent",
          !value && "text-muted-foreground/70",
          tone === "late" && "font-medium text-destructive",
          tone === "soon" && "font-medium text-primary",
          !tone && value && "text-muted-foreground",
        )}
      >
        {value ? fmtShort(value) : <CalendarPlus className="size-3.5" />}
      </button>
      <input
        ref={ref}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="pointer-events-none absolute inset-0 opacity-0"
      />
    </span>
  );
}

export const selectClass =
  "h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** The widget's menu: move it within its column, and hide (core) or remove (custom) it. */
export function WidgetMenu({ widget, title }: { widget: Widget; title: string }) {
  const { office, run } = useOffice();
  // up and down move among the widgets shown in the same column
  const zone = zoneOf(widget.type);
  const peers = office.widgets.filter((w) => !(isCore(w) && w.hidden) && zoneOf(w.type) === zone);
  const at = peers.findIndex((w) => w.id === widget.id);
  const indexOf = (id?: string) => office.widgets.findIndex((w) => w.id === id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`${title}: options`} className="text-muted-foreground">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={at <= 0}
          onSelect={() => run({ op: "widget.move", id: widget.id, to: indexOf(peers[at - 1]?.id) })}
        >
          <ArrowUp /> Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={at < 0 || at >= peers.length - 1}
          onSelect={() => run({ op: "widget.move", id: widget.id, to: indexOf(peers[at + 1]?.id) })}
        >
          <ArrowDown /> Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {isCore(widget) ? (
          <DropdownMenuItem onSelect={() => run({ op: "widget.hide", id: widget.id, hidden: true })}>
            <EyeOff /> Hide
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={() => run({ op: "widget.remove", id: widget.id })}>
            <Trash2 /> Remove
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A widget's frame. "panel": a bordered sheet in the main column (the record: journal, notes, tables). "rail": a
 *  heading over a plain list (the desk's side: tasks, people). The title toggles it open and closed. */
export function WidgetCard({
  widget,
  title,
  count,
  by,
  actions,
  children,
  variant = zoneOf(widget.type) === "rail" ? "rail" : "panel",
}: {
  widget: Widget;
  title: string;
  count?: React.ReactNode;
  by?: By;
  actions?: React.ReactNode;
  children: React.ReactNode;
  variant?: "panel" | "rail";
}) {
  const { run } = useOffice();
  const head = (
    <div className={cn("flex items-center gap-1", variant === "panel" ? "px-4 pt-3 pb-2" : "pb-1.5")}>
      <button
        type="button"
        onClick={() => run({ op: "widget.collapse", id: widget.id, collapsed: !widget.collapsed })}
        className="group flex min-w-0 flex-1 items-baseline gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={!widget.collapsed}
      >
        <h2 className="truncate font-serif text-[1.05rem] font-semibold tracking-tight">{title}</h2>
        {count != null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>}
        <AiMark by={by} className="self-center" />
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 self-center text-muted-foreground opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100",
            widget.collapsed && "-rotate-90 opacity-100",
          )}
        />
      </button>
      {!widget.collapsed && actions}
      <WidgetMenu widget={widget} title={title} />
    </div>
  );
  if (variant === "rail")
    return (
      <section aria-label={title}>
        <div className="border-b border-foreground/15">{head}</div>
        {!widget.collapsed && children}
      </section>
    );
  return (
    <section aria-label={title} className="rounded-lg border bg-card shadow-2xs">
      {head}
      {!widget.collapsed && children}
    </section>
  );
}
