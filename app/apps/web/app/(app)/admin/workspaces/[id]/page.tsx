import {
  Breakdown,
  PeriodRange,
  PeriodTabs,
  Person,
  periodParam,
  Section,
  Stat,
  Table,
  UsageCells,
  usageHead,
} from "@/components/admin/parts";
import { PageHeader } from "@/components/page-header";
import { fmtDate, fmtNum, fmtSize, fmtUsd } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /admin/workspaces/<id>: one workspace: its members and what each used, and its usage per kind over the period.
export default async function AdminWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const period = periodParam(sp.period);
  const w = await orNotFound((await serverApi()).admin.workspace({ id, period }));
  const q = period === "month" ? "" : `?period=${period}`;
  const used = (k: "chats" | "llmCalls" | "files" | "ocrPages") => w.members.reduce((s, m) => s + m.usage[k], 0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        crumbs={[{ label: "Admin" }, { label: "Usage", href: `/admin/usage${q}` }, { label: w.workspace.name }]}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-3xl font-semibold tracking-tight">{w.workspace.name}</h1>
              <p className="text-sm text-muted-foreground">
                Created {fmtDate(w.workspace.createdAt)} · {w.workspace.members} members · {w.workspace.cases} cases ·{" "}
                {w.workspace.files} files ({fmtSize(w.workspace.storedBytes)} stored)
              </p>
              <PeriodRange from={w.from} to={w.to} />
            </div>
            <PeriodTabs base={`/admin/workspaces/${id}`} current={period} />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cost" value={fmtUsd(w.total)} />
            <Stat label="Chats" value={fmtNum(used("chats"))} hint={`${fmtNum(used("llmCalls"))} model calls`} />
            <Stat label="Files processed" value={fmtNum(used("files"))} />
            <Stat label="OCR pages" value={fmtNum(used("ocrPages"))} />
          </div>

          <Section title="Members" hint="Their role here, and what each used in this workspace.">
            <Table
              head={[<th key="u">Member</th>, <th key="r">Role</th>, ...usageHead]}
              empty={w.members.length ? undefined : "No members."}
            >
              {w.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Person name={m.name} email={m.email} href={`/admin/users/${m.id}${q}`} />
                  </td>
                  <td className="text-muted-foreground">{m.role}</td>
                  <UsageCells u={m.usage} />
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="What was used" hint="Per kind of call, task and model.">
            <Breakdown rows={w.breakdown} />
          </Section>
        </div>
      </main>
    </div>
  );
}
