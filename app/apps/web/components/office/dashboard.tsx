"use client";
// The case dashboard (docs/APP.md, Case office): the office's widgets, drawn only from the fixed catalog, in three
// places. The cover band: the docket cover and the next date. The record (main column): the journal, notes, tables,
// timelines. The rail: tasks, people, checklists. Within each place the saved order holds. On a phone it is one
// column: the next date, then tasks, then the cover, then the rest. A slim bar adds a widget, shows hidden ones, resets
// the layout.
import { isCore, type Widget } from "@sllaw/office";
import { Eye, Loader2, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { zoneOf } from "@/lib/office";
import { cn } from "@/lib/utils";
import { type OfficeData, OfficeProvider, useOffice } from "./context";
import { HeaderWidget, JournalWidget, NextDateWidget, PeopleWidget, TasksWidget } from "./core";
import { ChecklistWidget, NoteWidget, TableWidget, TimelineWidget } from "./custom";

function Draw({ w, title }: { w: Widget; title: string }) {
  switch (w.type) {
    case "header":
      return <HeaderWidget widget={w} title={title} />;
    case "next_date":
      return <NextDateWidget widget={w} />;
    case "journal":
      return <JournalWidget widget={w} />;
    case "tasks":
      return <TasksWidget widget={w} />;
    case "people":
      return <PeopleWidget widget={w} />;
    case "note":
      return <NoteWidget widget={w} />;
    case "checklist":
      return <ChecklistWidget widget={w} />;
    case "table":
      return <TableWidget widget={w} />;
    case "timeline":
      return <TimelineWidget widget={w} />;
  }
}

const NAME: Record<string, string> = {
  header: "Case details",
  next_date: "Next date",
  journal: "Journal",
  tasks: "Tasks",
  people: "People",
};

// on a phone: the next date, then tasks, then the cover, then the rest in their saved order
const PHONE: Record<string, string> = { next_date: "order-1", tasks: "order-2", header: "order-3" };

function Toolbar() {
  const { office, run, pending } = useOffice();
  const hidden = office.widgets.filter((w) => isCore(w) && w.hidden);
  const add = (type: "note" | "checklist" | "table" | "timeline") =>
    run({
      op: "widget.add",
      widget:
        type === "note"
          ? { type, title: "Note", text: "" }
          : type === "checklist"
            ? { type, title: "Checklist", items: [] }
            : type === "table"
              ? { type, title: "Table", columns: ["Item", "Detail"], rows: [] }
              : { type, title: "Timeline of facts", events: [] },
    });
  return (
    <div className="flex items-center justify-end gap-0.5">
      {pending && (
        <span role="status" className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Saving…
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Plus /> Add to dashboard
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => add("note")} className="flex-col items-start gap-0">
            Note<span className="text-xs text-muted-foreground">Strategy, points to argue, instructions</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => add("checklist")} className="flex-col items-start gap-0">
            Checklist<span className="text-xs text-muted-foreground">Documents to collect, steps to take</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => add("table")} className="flex-col items-start gap-0">
            Table<span className="text-xs text-muted-foreground">Witnesses, marked documents, sums</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => add("timeline")} className="flex-col items-start gap-0">
            Timeline of facts<span className="text-xs text-muted-foreground">What happened, in order</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Dashboard options">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {hidden.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Hidden</DropdownMenuLabel>
              {hidden.map((w) => (
                <DropdownMenuItem key={w.id} onSelect={() => run({ op: "widget.hide", id: w.id, hidden: false })}>
                  <Eye /> Show {NAME[w.type]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => run({ op: "layout.reset" })} className="items-start">
            <RotateCcw className="mt-0.5" />
            <span>
              Reset the layout
              <span className="block text-xs text-muted-foreground">
                Default widgets and order. Added widgets are removed.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function Board({ title }: { title: string }) {
  const { office, error, clearError } = useOffice();
  const shown = office.widgets.filter((w) => !(isCore(w) && w.hidden));
  const at = (zone: string) => shown.filter((w) => zoneOf(w.type) === zone);
  const cover = at("cover");
  const item = (w: Widget, extra?: string) => (
    <div key={w.id} className={cn("min-w-0 lg:order-none", PHONE[w.type] ?? "order-4", extra)}>
      <Draw w={w} title={title} />
    </div>
  );
  return (
    <div className="space-y-3">
      <Toolbar />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {error}
            <Button size="sm" variant="ghost" onClick={clearError}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!cover.some((w) => w.type === "header") && <h1 className="text-2xl font-semibold">{title}</h1>}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-x-8 lg:gap-y-8">
        {cover.map((w) =>
          item(
            w,
            w.type === "header"
              ? "lg:col-start-1 lg:row-start-1 lg:self-stretch"
              : "lg:col-start-2 lg:row-start-1 lg:self-stretch",
          ),
        )}
        <div className="contents lg:col-start-1 lg:row-start-2 lg:flex lg:flex-col lg:gap-5">
          {at("main").map((w) => item(w))}
        </div>
        <div className="contents lg:col-start-2 lg:row-start-2 lg:flex lg:flex-col lg:gap-8">
          {at("rail").map((w) => item(w))}
        </div>
      </div>
    </div>
  );
}

export function CaseDashboard({ caseId, title, initial }: { caseId: string; title: string; initial: OfficeData }) {
  return (
    <OfficeProvider caseId={caseId} initial={initial}>
      <Board title={title} />
    </OfficeProvider>
  );
}
