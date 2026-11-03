import Link from "next/link";
import {
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
import { fmtNum, fmtSize, fmtUsd } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /admin/usage: what the whole platform used over a period, per workspace and per user.
export default async function AdminUsagePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const period = periodParam((await searchParams).period);
  const u = await orNotFound((await serverApi()).admin.usage({ period }));
  const t = u.total;
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Admin" }, { label: "Usage" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-3xl font-semibold tracking-tight">Usage</h1>
              <PeriodRange from={u.from} to={u.to} />
            </div>
            <PeriodTabs base="/admin/usage" current={period} />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cost" value={fmtUsd(t.costUsd)} hint={`${fmtNum(t.events)} metered calls`} />
            <Stat label="Chats" value={fmtNum(t.chats)} hint={`${fmtNum(t.llmCalls)} model calls`} />
            <Stat label="Model tokens" value={fmtNum(t.tokens)} hint={`${fmtNum(t.embedTokens)} embedding tokens`} />
            <Stat
              label="Files processed"
              value={fmtNum(t.files)}
              hint={`${fmtNum(t.ocrPages)} OCR pages · ${fmtSize(t.uploadedBytes)} uploaded`}
            />
          </div>

          <Section title="Workspaces" hint="Every workspace, the most spent first. Stored is what its files hold now.">
            <Table
              head={[
                <th key="w">Workspace</th>,
                <th key="m" className="num">
                  Members
                </th>,
                <th key="s" className="num">
                  Stored
                </th>,
                ...usageHead,
              ]}
              empty={u.workspaces.length ? undefined : "No workspaces yet."}
            >
              {u.workspaces.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link
                      href={`/admin/workspaces/${w.id}${period === "month" ? "" : `?period=${period}`}`}
                      className="font-medium hover:underline"
                    >
                      {w.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {w.cases} cases · {w.files} files
                    </div>
                  </td>
                  <td className="num">{w.members}</td>
                  <td className="num">{fmtSize(w.storedBytes)}</td>
                  <UsageCells u={w.usage} />
                </tr>
              ))}
              {u.unattributed.map((w) => (
                <tr key={w.workspaceId ?? "none"} className="text-muted-foreground">
                  <td colSpan={3}>{w.workspaceId ? "Deleted workspace" : "No workspace (scripts, evals)"}</td>
                  <UsageCells u={w} />
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="Users" hint="Everyone who used anything in this period, across their workspaces.">
            <Table
              head={[<th key="u">User</th>, ...usageHead]}
              empty={u.users.length ? undefined : "No usage in this period."}
            >
              {u.users.map((x) => (
                <tr key={x.userId ?? "none"}>
                  <td>
                    {x.userId ? (
                      <Person
                        name={x.name}
                        email={x.email}
                        href={`/admin/users/${x.userId}${period === "month" ? "" : `?period=${period}`}`}
                      />
                    ) : (
                      <span className="text-muted-foreground">No user (file steps of a deleted user, scripts)</span>
                    )}
                  </td>
                  <UsageCells u={x.usage} />
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      </main>
    </div>
  );
}
