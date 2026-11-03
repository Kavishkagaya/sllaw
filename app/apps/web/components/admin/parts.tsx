// The admin pages' parts, rendered on the server: the period tabs, a stat, a table and a usage row's cells.
import { cn } from "cn";
import Link from "next/link";
import { fmtDate, fmtNum, fmtSize, fmtUsd } from "@/lib/format";

export const PERIODS = [
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
] as const;
export type PeriodId = (typeof PERIODS)[number]["id"];

export const periodParam = (p: string | string[] | undefined): PeriodId =>
  PERIODS.find((x) => x.id === p)?.id ?? "month";

/** Links to the same page for each period; the current one marked. */
export function PeriodTabs({ base, current }: { base: string; current: PeriodId }) {
  return (
    <nav className="inline-flex flex-wrap gap-1 rounded-lg border p-1 text-sm" aria-label="Period">
      {PERIODS.map((p) => (
        <Link
          key={p.id}
          href={p.id === "month" ? base : `${base}?period=${p.id}`}
          aria-current={p.id === current ? "page" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground",
            p.id === current && "bg-secondary font-medium text-foreground",
          )}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}

/** The period as dates: "1 Nov 2026 – 30 Nov 2026" (the end is exclusive, so a day before it). */
export function PeriodRange({ from, to }: { from: Date; to: Date }) {
  const last = new Date(new Date(to).getTime() - 1);
  return (
    <span className="text-sm text-muted-foreground">
      {fmtDate(from)} – {fmtDate(last)}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A table that scrolls sideways on its own on a narrow screen. Numeric columns: className "num". */
export function Table({
  head,
  children,
  empty,
}: {
  head: React.ReactNode[];
  children: React.ReactNode;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm [&_.num]:text-right [&_.num]:tabular-nums [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y [&_tr:hover]:bg-muted/30">{children}</tbody>
      </table>
      {empty && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

export type Totals = {
  costUsd: number;
  events: number;
  llmCalls: number;
  tokens: number;
  embedTokens: number;
  ocrPages: number;
  uploadedBytes: number;
  chats: number;
  files: number;
};

/** The usage columns every usage table shares, in this order. */
export const usageHead = [
  <th key="cost" className="num">
    Cost
  </th>,
  <th key="chats" className="num">
    Chats
  </th>,
  <th key="llm" className="num">
    Model calls
  </th>,
  <th key="tok" className="num">
    Tokens
  </th>,
  <th key="files" className="num">
    Files
  </th>,
  <th key="ocr" className="num">
    OCR pages
  </th>,
  <th key="up" className="num">
    Uploaded
  </th>,
];

export function UsageCells({ u }: { u: Totals }) {
  const dim = (n: number, s: string) => <span className={n ? undefined : "text-muted-foreground/50"}>{s}</span>;
  return (
    <>
      <td className="num font-medium">{dim(u.costUsd, fmtUsd(u.costUsd))}</td>
      <td className="num">{dim(u.chats, fmtNum(u.chats))}</td>
      <td className="num">{dim(u.llmCalls, fmtNum(u.llmCalls))}</td>
      <td className="num">{dim(u.tokens, fmtNum(u.tokens))}</td>
      <td className="num">{dim(u.files, fmtNum(u.files))}</td>
      <td className="num">{dim(u.ocrPages, fmtNum(u.ocrPages))}</td>
      <td className="num">{dim(u.uploadedBytes, u.uploadedBytes ? fmtSize(u.uploadedBytes) : "0")}</td>
    </>
  );
}

/** Usage per kind, task and model: what was used, how much of it, and what it cost. */
export function Breakdown({
  rows,
}: {
  rows: {
    kind: string;
    task: string;
    model: string | null;
    events: number;
    costUsd: number;
    estimated: boolean;
    quantity: Record<string, number>;
  }[];
}) {
  return (
    <Table
      head={[
        <th key="k">Kind</th>,
        <th key="t">Task</th>,
        <th key="m">Model</th>,
        <th key="q">Quantity</th>,
        <th key="e" className="num">
          Calls
        </th>,
        <th key="c" className="num">
          Cost
        </th>,
      ]}
      empty={rows.length ? undefined : "No usage in this period."}
    >
      {rows.map((r) => (
        <tr key={`${r.kind}|${r.task}|${r.model}`}>
          <td className="font-medium">{r.kind}</td>
          <td>{r.task}</td>
          <td className="max-w-56 truncate text-muted-foreground" title={r.model ?? ""}>
            {r.model ?? "–"}
          </td>
          <td className="text-muted-foreground">
            {Object.entries(r.quantity)
              .filter(([, v]) => v)
              .map(([k, v]) => `${fmtNum(v)} ${k}`)
              .join(" · ") || "–"}
          </td>
          <td className="num">{fmtNum(r.events)}</td>
          <td className="num font-medium">
            {fmtUsd(r.costUsd)}
            {r.estimated && (
              <span className="ml-1 text-xs text-muted-foreground" title="Estimated from list prices, not the bill">
                est.
              </span>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** A person as a cell: name, and email under it. */
export function Person({ name, email, href }: { name: string | null; email: string | null; href?: string }) {
  const body = (
    <>
      <div className="font-medium">{name || email || "Unknown user"}</div>
      {name && email && <div className="text-xs text-muted-foreground">{email}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="block hover:underline">
      {body}
    </Link>
  ) : (
    body
  );
}
