"use client";
// How an answer was researched, in a lawyer's terms: thinking (expandable), what was searched and found, which
// provisions were read, how they were amended, which related laws were looked at. No ids, modes or directions.
import type { ChatMessage } from "@sllaw/api";
import { Brain, ChevronRight, FileText, GitCompareArrows, Link2, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type Part = ChatMessage["parts"][number];

const ORD = (n: string) => n + (["11", "12", "13"].includes(n.slice(-2)) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<string, string>)[n.slice(-1)] ?? "th");

/** A law's key as a lawyer writes it: act:7/2010 → Act No. 7 of 2010. */
export function lawName(key: string) {
  const [kind, rest = ""] = key.split(":");
  const [n, y] = rest.split("/");
  if ((kind === "act" || kind === "law") && y) return `${kind === "act" ? "Act" : "Law"} No. ${n} of ${y}`;
  if (kind === "constitution") return n ? `Constitution (as amended to the ${ORD(n)} Amendment)` : "Constitution (1978, as enacted)";
  if (kind === "amendment") return `${ORD(n!)} Amendment to the Constitution`;
  if (kind === "cap") return `Cap. ${n} (1980 Revised Edition)`;
  if (kind === "cap1956") return `Cap. ${n} (1956 Revised Edition)`;
  if (kind === "chapter") return `Chapter ${n}`;
  return key;
}
const provision = (c: { label: string | null; title: string | null; docKey: string }) =>
  [c.label && (/^\d/.test(c.label) ? `s. ${c.label}` : c.label), c.title ?? lawName(c.docKey)].filter(Boolean).join(", ");
const KIND: Record<string, string> = {
  amends: "amend", inserts: "insert into", replaces: "replace parts of", repeals: "repeal parts of", amends_act: "amend",
  repeals_act: "repeal", cites: "refer to", same_as: "are the same law as", consolidates: "consolidate",
};
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The answer is the text after the last tool call; the rest (thinking included, also after it) is the trail. */
export function splitAnswer(parts: Part[]) {
  const lastTool = parts.findLastIndex((p) => p.type.startsWith("tool-"));
  return {
    trail: parts.filter((p, i) => p.type !== "step-start" && (p.type !== "text" || i < lastTool)),
    answer: parts.filter((p, i) => p.type === "text" && i > lastTool),
  };
}

/** Titles the research has seen, by law key, so a row with only a key can still name the law properly. */
function titlesOf(parts: Part[]) {
  const t = new Map<string, string>();
  const add = (c: { docKey: string; title: string | null }) => c.title && t.set(c.docKey, c.title);
  for (const p of parts) {
    if (p.type === "tool-search" && p.state === "output-available" && Array.isArray(p.output)) p.output.forEach(add);
    if (p.type === "tool-read" && p.state === "output-available") p.output.forEach(add);
    if (p.type === "tool-asOf" && p.state === "output-available" && p.output) {
      add(p.output.chunk);
      p.output.changes.forEach((c) => c.byTitle && t.set(c.by, c.byTitle));
    }
  }
  return (key: string) => t.get(key) ?? lawName(key);
}

export function Trail({ parts, live }: { parts: Part[]; live: boolean }) {
  // open while the agent works; a finished answer shows its trail folded
  const [open, setOpen] = useState(live);
  const steps = parts.filter((p) => p.type !== "reasoning" && p.type !== "text");
  if (!parts.length) return null;
  const count = (t: string) => steps.filter((p) => p.type === t).length;
  const reads = parts.flatMap((p) => (p.type === "tool-read" && p.state === "output-available" ? p.output : [])).length;
  const summary = [
    count("tool-search") && plural(count("tool-search"), "search", "searches"),
    reads && `${plural(reads, "provision", "provisions")} read`,
    count("tool-asOf") && plural(count("tool-asOf"), "amendment check", "amendment checks"),
  ].filter(Boolean).join(", ");
  const name = titlesOf(parts);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-muted/30">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
        {live ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />}
        <span className="shrink-0 font-medium">{live ? "Researching" : "Researched"}</span>
        {summary && <span className="min-w-0 truncate">· {summary}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="flex flex-col gap-2 border-t px-3 py-2.5">
          {parts.map((p, i) => <Step key={i} p={p} name={name} active={live && i === parts.length - 1} />)}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Row({ icon: Icon, spin, children }: { icon: React.ComponentType<{ className?: string }>; spin?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-xs text-muted-foreground">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", spin && "animate-spin")} />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </li>
  );
}

const Laws = ({ names }: { names: string[] }) =>
  names.length ? (
    <div className="flex flex-wrap gap-1">
      {names.slice(0, 5).map((n) => <span key={n} className="rounded border bg-background px-1.5 py-px text-[11px]">{n}</span>)}
      {names.length > 5 && <span className="text-[11px]">+{names.length - 5} more</span>}
    </div>
  ) : null;

function Step({ p, name, active }: { p: Part; name: (key: string) => string; active: boolean }) {
  const [open, setOpen] = useState(false);
  if (p.type === "reasoning") {
    if (!p.text.trim()) return null;
    return (
      <li>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
            {active ? <Loader2 className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
            <span>{active ? "Thinking…" : "Thinking"}</span>
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1.5 ml-5.5 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{p.text.trim()}</p>
          </CollapsibleContent>
        </Collapsible>
      </li>
    );
  }
  if (p.type === "text") return p.text.trim() ? <li className="ml-5.5 text-xs text-muted-foreground italic">{p.text.trim()}</li> : null;

  const running = p.type.startsWith("tool-") && "state" in p && p.state !== "output-available" && p.state !== "output-error";
  const failed = "state" in p && p.state === "output-error";
  if (p.type === "tool-search") {
    const within = p.input?.docKeys?.flatMap((k) => (k ? [name(k)] : []));
    const found = p.state === "output-available" && Array.isArray(p.output) ? uniq(p.output.map((h) => h.title ?? lawName(h.docKey))) : [];
    return (
      <Row icon={running ? Loader2 : Search} spin={running}>
        <p>
          Searched <span className="text-foreground">“{p.input?.query}”</span>
          {within?.length ? <> in {within.join(", ")}</> : null}
          {p.state === "output-available" && typeof p.output === "string" && <> — not in the corpus</>}
          {p.state === "output-available" && Array.isArray(p.output) && !p.output.length && <> — nothing found</>}
          {failed && <> — failed</>}
        </p>
        <Laws names={found} />
      </Row>
    );
  }
  if (p.type === "tool-read") {
    const read = p.state === "output-available" ? p.output.map(provision) : [];
    return (
      <Row icon={running ? Loader2 : FileText} spin={running}>
        <p>{running ? "Reading provisions…" : failed ? "Reading failed" : `Read ${read.length === 1 ? read[0] : plural(read.length, "provision", "provisions")}`}</p>
        {read.length > 1 && <ul className="list-disc pl-4">{read.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      </Row>
    );
  }
  if (p.type === "tool-asOf") {
    const o = p.state === "output-available" ? p.output : null;
    const last = o?.changes.at(-1)?.date;
    return (
      <Row icon={running ? Loader2 : GitCompareArrows} spin={running}>
        {running ? <p>Checking amendments…</p> : !o ? <p>Amendment check failed</p> : (
          <>
            <p>
              Amendments to <span className="text-foreground">{provision(o.chunk)}</span>:{" "}
              {o.changes.length ? `amended ${plural(o.changes.length, "time", "times")}${last ? `, last ${last}` : ""}` : "not amended"}
            </p>
            <Laws names={uniq(o.changes.map((c) => name(c.by)))} />
          </>
        )}
      </Row>
    );
  }
  if (p.type === "tool-links") {
    const groups = p.state === "output-available" ? p.output : [];
    const subject = p.input?.docKey ? name(p.input.docKey) : "the provision";
    const kinds = uniq(groups.map((g) => KIND[g.kind] ?? "relate to"));
    return (
      <Row icon={running ? Loader2 : Link2} spin={running}>
        <p>
          {running ? `Looking up laws related to ${subject}…` : failed ? `Looking up related laws failed` : p.input?.direction === "out"
            ? `Looked at the laws ${subject} refers to`
            : `Looked at laws that ${kinds.join(" or ") || "relate to"} ${subject}`}
          {!running && !failed && !groups.length && " — none"}
        </p>
        <Laws names={uniq(groups.map((g) => name(g.law)))} />
      </Row>
    );
  }
  return null;
}
