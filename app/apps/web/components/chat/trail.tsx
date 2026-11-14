"use client";
// How an answer was researched, in a lawyer's terms (neethi-redesign d11): while it works, each step appears live on
// a dotted thread under the working arch, with a timer; finished, the trail folds to one line ("How I got here") and
// opens into sentences: what it looked for, what it found, chips that open in the sources panel, thinking as a short
// excerpt. No ids, modes or directions.
import type { ChatMessage } from "@sllaw/api";
import {
  BookOpen,
  Brain,
  ChevronRight,
  FileSearch,
  Files,
  FileText,
  FolderOpen,
  GitCompareArrows,
  LayoutDashboard,
  Link2,
  Loader2,
  Pencil,
  Search,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { BrandMark } from "@/components/brand";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** What a chip in the trail opens in the sources panel: a law's chunk, or a passage of a case file. */
export type TrailSource =
  | { kind: "law"; chunkId: number; label: string }
  | { kind: "file"; fileId: string; n: number; label: string };
const OpenSource = createContext<(s: TrailSource) => void>(() => {});

type Part = ChatMessage["parts"][number];

const ORD = (n: string) =>
  n +
  (["11", "12", "13"].includes(n.slice(-2))
    ? "th"
    : (({ 1: "st", 2: "nd", 3: "rd" } as Record<string, string>)[n.slice(-1)] ?? "th"));

/** A law's key as a lawyer writes it: act:7/2010 → Act No. 7 of 2010. */
export function lawName(key: string) {
  const [kind, rest = ""] = key.split(":");
  const [n, y] = rest.split("/");
  if ((kind === "act" || kind === "law") && y) return `${kind === "act" ? "Act" : "Law"} No. ${n} of ${y}`;
  if (kind === "constitution")
    return n ? `Constitution (as amended to the ${ORD(n)} Amendment)` : "Constitution (1978, as enacted)";
  if (kind === "amendment") return `${ORD(n!)} Amendment to the Constitution`;
  if (kind === "cap") return `Cap. ${n} (1980 Revised Edition)`;
  if (kind === "cap1956") return `Cap. ${n} (1956 Revised Edition)`;
  if (kind === "chapter") return `Chapter ${n}`;
  return key;
}
type Prov = { label: string | null; title: string | null; docKey: string };
const isConstitution = (key: string) => key === "constitution" || key.startsWith("constitution:");
/** "13" → "Art. 13" in the Constitution, "s. 13" elsewhere; a named label ("First Schedule") as it is. */
const pin = (c: Prov) =>
  c.label && (/^\d/.test(c.label) ? `${isConstitution(c.docKey) ? "Art." : "s."} ${c.label}` : c.label);
const provision = (c: Prov) => [pin(c), c.title ?? lawName(c.docKey)].filter(Boolean).join(", ");
/** A law's name, short, for a chip: "CODE OF CRIMINAL PROCEDURE ACT, No. 15 OF 1979" → "Code of Criminal Procedure
 *  Act"; the Constitution as "Constitution". */
function shortLaw(c: Prov) {
  if (isConstitution(c.docKey)) return "Constitution";
  const t = (c.title ?? lawName(c.docKey)).split(/,|\(/)[0]!.trim();
  return t === t.toUpperCase()
    ? t.toLowerCase().replace(/\b(?!of\b|and\b|the\b|for\b|in\b)\w/g, (x) => x.toUpperCase())
    : t;
}
const chip = (c: Prov) => [pin(c), shortLaw(c)].filter(Boolean).join(", ");
const KIND: Record<string, string> = {
  amends: "amend",
  inserts: "insert into",
  replaces: "replace parts of",
  repeals: "repeal parts of",
  amends_act: "amend",
  repeals_act: "repeal",
  cites: "refer to",
  same_as: "are the same law as",
  consolidates: "consolidate",
};
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The answer is the text after the last tool call; the rest (thinking included, also after it) is the trail. An `ask`
 *  call (reply chips, removed 2026-11-14) came after the answer in older chats, so it does not count. */
export function splitAnswer(parts: Part[]) {
  const lastTool = parts.findLastIndex((p) => p.type.startsWith("tool-") && (p.type as string) !== "tool-ask");
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
      for (const c of p.output.changes) if (c.byTitle) t.set(c.by, c.byTitle);
    }
  }
  return (key: string) => t.get(key) ?? lawName(key);
}

/** m:ss since the trail went live: the colleague's time on this question. */
function Timer() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return (
    <span className="label-mono ml-auto text-[10px] text-muted-foreground tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function Trail({ parts, live, onOpen }: { parts: Part[]; live: boolean; onOpen?: (s: TrailSource) => void }) {
  const [open, setOpen] = useState(false);
  const steps = parts.filter((p) => p.type !== "reasoning" && p.type !== "text");
  if (!parts.length && !live) return null;
  const count = (t: string) => steps.filter((p) => p.type === t).length;
  const reads = parts.flatMap((p) => (p.type === "tool-read" && p.state === "output-available" ? p.output : [])).length;
  const passagesRead = parts
    .flatMap((p) => (p.type === "tool-fileRead" && p.state === "output-available" ? readFiles(p.output) : []))
    .flatMap((f) => f.chunks).length;
  const summary = [
    count("tool-search") && plural(count("tool-search"), "search", "searches"),
    reads && plural(reads, "provision", "provisions"),
    count("tool-asOf") && plural(count("tool-asOf"), "amendment check", "amendment checks"),
    count("tool-fileSearch") && plural(count("tool-fileSearch"), "file search", "file searches"),
    passagesRead && plural(passagesRead, "file passage", "file passages"),
  ]
    .filter(Boolean)
    .join(" · ");
  const name = titlesOf(parts);
  const thread = (
    <ol className="relative">
      <span
        aria-hidden
        className="absolute top-1.5 bottom-5 left-[10px] w-0.5 [background-image:radial-gradient(circle,var(--input)_1px,transparent_1.2px)] [background-size:2px_6px]"
      />
      {parts.map((p, i) => (
        <Step key={i} p={p} name={name} active={live && i === parts.length - 1} />
      ))}
    </ol>
  );
  return (
    <OpenSource.Provider value={onOpen ?? (() => {})}>
      {live ? (
        <div aria-live="polite">
          <div className="mb-3.5 flex items-center gap-2.5">
            <BrandMark working className="size-5" />
            <span className="text-sm font-semibold">Working on it</span>
            <Timer />
          </div>
          {thread}
          <div aria-hidden className="mt-1 flex flex-col gap-2">
            <span className="h-2.5 w-[92%] animate-pulse rounded-full bg-muted" />
            <span className="h-2.5 w-[70%] animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex min-h-9 w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            <b className="shrink-0 font-semibold text-foreground">How I got here</b>
            {summary && <span className="min-w-0 truncate">· {summary}</span>}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3.5">{thread}</CollapsibleContent>
        </Collapsible>
      )}
    </OpenSource.Provider>
  );
}

/** One step on the thread: its dot (icon in a circle), then the sentence. */
function Row({
  icon: Icon,
  spin,
  active,
  mark,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
  active?: boolean;
  mark?: boolean; // a playbook step: the dot filled in oxblood
  children: React.ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-3.5">
      <span
        className={cn(
          "relative z-[1] flex size-[22px] shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground",
          mark && "border-primary bg-primary text-primary-foreground",
          active && !mark && "border-primary text-primary",
        )}
      >
        <Icon className={cn("size-[11px]", spin && "animate-spin")} />
      </span>
      <div className={cn("min-w-0 flex-1 space-y-1 pt-0.5 text-[13.5px]", active && "font-medium text-primary")}>
        {children}
      </div>
    </li>
  );
}

/** A law or file named in a step: a chip; with `src` it opens that source in the panel. */
function Chip({ children, file, src }: { children: React.ReactNode; file?: boolean; src?: TrailSource }) {
  const open = useContext(OpenSource);
  const cls = cn(
    "mt-1 mr-1 inline-flex max-w-full items-center truncate rounded-[5px] border px-[7px] py-px text-[11.5px] font-medium",
    file
      ? "border-file-border bg-file text-file-ink"
      : src
        ? "border-law-border bg-law text-law-ink"
        : "bg-card text-foreground/80",
  );
  return src ? (
    <button type="button" onClick={() => open(src)} className={cn(cls, "cursor-pointer hover:brightness-95")}>
      {children}
    </button>
  ) : (
    <span className={cls}>{children}</span>
  );
}

const Laws = ({ names }: { names: string[] }) =>
  names.length ? (
    <div className="flex flex-wrap">
      {names.slice(0, 5).map((n) => (
        <Chip key={n}>{n}</Chip>
      ))}
      {names.length > 5 && <span className="mt-1 text-[11px] text-muted-foreground">+{names.length - 5} more</span>}
    </div>
  ) : null;

/** Thinking, short: its first lines as an excerpt, never the full chain. */
const excerpt = (t: string) => {
  const one = t.trim().replace(/\s+/g, " ");
  return one.length > 220 ? `${one.slice(0, 220).replace(/\s\S*$/, "")}…` : one;
};

function Step({ p, name, active }: { p: Part; name: (key: string) => string; active: boolean }) {
  if (p.type === "reasoning") {
    if (!p.text.trim()) return null;
    return (
      <Row icon={active ? Loader2 : Brain} spin={active} active={active}>
        <p>{active ? "Thinking it through…" : "Thought it through"}</p>
        {!active && (
          <p className="font-law text-[13px] leading-normal text-muted-foreground italic">“{excerpt(p.text)}”</p>
        )}
      </Row>
    );
  }
  if (p.type === "text")
    return p.text.trim() ? (
      <li className="mb-3 ml-[34px] text-[13px] text-muted-foreground italic">{p.text.trim()}</li>
    ) : null;

  const running =
    p.type.startsWith("tool-") && "state" in p && p.state !== "output-available" && p.state !== "output-error";
  const failed = "state" in p && p.state === "output-error";
  if (p.type === "tool-search") {
    const within = p.input?.docKeys?.flatMap((k) => (k ? [name(k)] : []));
    const found =
      p.state === "output-available" && Array.isArray(p.output)
        ? uniq(p.output.map((h) => h.title ?? lawName(h.docKey)))
        : [];
    return (
      <Row icon={running ? Loader2 : Search} spin={running} active={running}>
        <p>
          Searched the law for <i>“{p.input?.query}”</i>
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
    const read = p.state === "output-available" ? p.output : [];
    return (
      <Row icon={running ? Loader2 : FileText} spin={running} active={running}>
        <p>
          {running
            ? "Reading the provisions…"
            : failed
              ? "Reading failed"
              : read.length === 1
                ? "Read"
                : `Read ${plural(read.length, "provision", "provisions")}`}
        </p>
        {read.length > 0 && (
          <div className="flex flex-wrap">
            {read.map((r) => (
              <Chip key={r.chunkId} src={{ kind: "law", chunkId: r.chunkId, label: chip(r) }}>
                {chip(r)}
              </Chip>
            ))}
          </div>
        )}
      </Row>
    );
  }
  if (p.type === "tool-asOf") {
    const o = p.state === "output-available" ? p.output : null;
    const last = o?.changes.at(-1)?.date;
    return (
      <Row icon={running ? Loader2 : GitCompareArrows} spin={running} active={running}>
        {running ? (
          <p>Checking amendments…</p>
        ) : !o ? (
          <p>Amendment check failed</p>
        ) : (
          <>
            <p>
              Checked <span className="text-foreground">{provision(o.chunk)}</span> for amendments:{" "}
              {o.changes.length
                ? `amended ${plural(o.changes.length, "time", "times")}${last ? `, last ${last}` : ""}`
                : "not amended"}
            </p>
            <Laws names={uniq(o.changes.map((c) => name(c.by)))} />
          </>
        )}
      </Row>
    );
  }
  if (p.type === "tool-fileSearch") {
    const o = p.state === "output-available" ? p.output : null;
    const found = o && typeof o === "object" ? uniq(o.hits.map((h) => h.title)) : [];
    return (
      <Row icon={running ? Loader2 : FileSearch} spin={running} active={running}>
        <p>
          Searched the case files for <i>“{p.input?.query}”</i>
          {typeof o === "string" && <> — {o}</>}
          {o && typeof o === "object" && !o.hits.length && <> — nothing found</>}
          {failed && <> — failed</>}
        </p>
        <Laws names={found} />
      </Row>
    );
  }
  if (p.type === "tool-fileCard") {
    const o = p.state === "output-available" ? p.output : null;
    const fixing = !!p.input?.correct;
    // camelCase keys as words: causeOfAction -> cause of action, docType -> type
    const words = (k: string) => (k === "docType" ? "type" : k.replace(/([A-Z])/g, " $1").toLowerCase());
    if (fixing) {
      const c = o && typeof o === "object" && "corrected" in o ? o.corrected : null;
      return (
        <Row icon={running ? Loader2 : Pencil} spin={running} active={running}>
          <p>
            {running
              ? "Correcting a file's details…"
              : failed
                ? "Correcting a file's details failed"
                : c
                  ? `Corrected ${c.title}: ${c.changed.map(words).join(", ")}`
                  : `Did not correct the file — ${typeof o === "string" ? o : "no change"}`}
          </p>
        </Row>
      );
    }
    const titles = o && typeof o === "object" && "cards" in o ? (o.cards ?? []).map((c) => c.title) : [];
    const listed = o && typeof o === "object" && "files" in o;
    return (
      <Row icon={running ? Loader2 : Files} spin={running} active={running}>
        <p>
          {running
            ? "Looking at the case files…"
            : failed
              ? "Looking at the case files failed"
              : listed
                ? "Listed the case files"
                : typeof o === "string"
                  ? `Looked for a case file — ${o}`
                  : `Looked at what ${titles.length === 1 ? "a file is" : "the files are"}`}
        </p>
        <Laws names={titles} />
      </Row>
    );
  }
  if (p.type === "tool-fileRead") {
    const o = p.state === "output-available" ? p.output : null;
    const read = readFiles(o);
    const span = (f: (typeof read)[number]) => {
      const ns = uniq(f.chunks.map((c) => c.page));
      return ns.length > 1 ? `pp. ${ns[0]}–${ns.at(-1)}` : ns.length ? `p. ${ns[0]}` : "";
    };
    return (
      <Row icon={running ? Loader2 : FolderOpen} spin={running} active={running}>
        <p>
          {running
            ? "Reading a case file…"
            : failed
              ? "Reading a case file failed"
              : typeof o === "string"
                ? `Could not read a case file — ${o}`
                : read.length
                  ? "Read in your files"
                  : o
                    ? "Read a case file"
                    : null}
        </p>
        {read.length > 0 && (
          <div className="flex flex-wrap">
            {read.map((f) => {
              const first = f.chunks[0];
              const n = first ? Number(first.chunk.split(":").at(-1)) : Number.NaN;
              const label = `${f.title}${span(f) ? `, ${span(f)}` : ""}`;
              return (
                <Chip
                  key={f.file}
                  file
                  src={Number.isFinite(n) ? { kind: "file", fileId: f.file, n, label } : undefined}
                >
                  {label}
                </Chip>
              );
            })}
          </div>
        )}
      </Row>
    );
  }
  if (p.type === "tool-playbook")
    return (
      <Row icon={running ? Loader2 : BookOpen} spin={running} active={running} mark={!running && !failed}>
        <p>
          Opened the <b className="font-semibold">{p.input?.name}</b> playbook
          {failed && <> — failed</>}
        </p>
      </Row>
    );
  if (p.type === "tool-caseRead")
    return (
      <Row icon={running ? Loader2 : LayoutDashboard} spin={running} active={running}>
        <p>Read the case page</p>
      </Row>
    );
  if (p.type === "tool-caseUpdate") {
    const out = p.state === "output-available" ? p.output : null;
    return (
      <Row icon={running ? Loader2 : LayoutDashboard} spin={running} active={running}>
        <p>
          {running
            ? "Updating the case…"
            : typeof out === "string"
              ? out
              : failed
                ? "Saving to the case page failed"
                : `Saved to the case page: ${out?.summary ?? p.input?.summary}`}
        </p>
      </Row>
    );
  }
  if (p.type === "tool-links") {
    const groups = p.state === "output-available" ? p.output : [];
    const subject = p.input?.docKey ? name(p.input.docKey) : "the provision";
    const kinds = uniq(groups.map((g) => KIND[g.kind] ?? "relate to"));
    return (
      <Row icon={running ? Loader2 : Link2} spin={running} active={running}>
        <p>
          {running
            ? `Looking up laws related to ${subject}…`
            : failed
              ? `Looking up related laws failed`
              : p.input?.direction === "out"
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

/** A fileRead output's files and passages; [] for an error, and for an old chat's read (pages, before passages). */
function readFiles(o: unknown) {
  return o && typeof o === "object" && "files" in o && Array.isArray(o.files)
    ? (o.files as { file: string; title: string; chunks: { chunk: string; page: number }[] }[])
    : [];
}
