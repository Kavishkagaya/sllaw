import Link from "next/link";
import { DailyCostChart } from "@/components/admin/daily-cost-chart";
import { PeriodRange, PeriodTabs, Person, periodParam, Section, Stat, Table } from "@/components/admin/parts";
import { PageHeader } from "@/components/page-header";
import { fmtDate, fmtNum, fmtSize, fmtUsd } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

/** "+12% vs previous", "new" when there was nothing before, nothing when both are 0. */
function change(now: number, before: number, what: string) {
  if (!now && !before) return undefined;
  if (!before) return `none the ${what} before`;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? "+" : ""}${pct}% on the ${what} before`;
}

// /admin: the platform at a glance: spend and activity over the period against the one before, cost per day, the
// top workspaces and users, the newest sign-ups.
export default async function AdminDashboard({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const period = periodParam((await searchParams).period);
  const d = await orNotFound((await serverApi()).admin.dashboard({ period }));
  const q = period === "month" ? "" : `?period=${period}`;
  const what = period === "month" || period === "last-month" ? "month" : "period";
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Admin" }, { label: "Dashboard" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
              <PeriodRange from={d.from} to={d.to} />
            </div>
            <PeriodTabs base="/admin" current={period} />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cost" value={fmtUsd(d.total.costUsd)} hint={change(d.total.costUsd, d.before.costUsd, what)} />
            <Stat label="Chats" value={fmtNum(d.total.chats)} hint={change(d.total.chats, d.before.chats, what)} />
            <Stat
              label="Active users"
              value={fmtNum(d.users.active)}
              hint={`of ${d.users.total} · ${d.users.new} new`}
            />
            <Stat
              label="Active workspaces"
              value={fmtNum(d.workspaces.active)}
              hint={`of ${d.workspaces.total} · ${d.workspaces.new} new`}
            />
            <Stat
              label="Model tokens"
              value={fmtNum(d.total.tokens)}
              hint={`${fmtNum(d.total.llmCalls)} model calls`}
            />
            <Stat
              label="Files processed"
              value={fmtNum(d.total.files)}
              hint={`${fmtNum(d.total.ocrPages)} OCR pages`}
            />
            <Stat label="Uploaded" value={fmtSize(d.total.uploadedBytes)} hint="in the period" />
            <Stat label="Stored" value={fmtSize(d.workspaces.storedBytes)} hint="all files, now" />
          </div>

          <Section title="Cost per day" hint="What every metered call cost us, per day (Sri Lanka time).">
            <div className="rounded-xl border bg-card p-4">
              <DailyCostChart days={d.daily} />
            </div>
          </Section>

          <div className="grid gap-x-6 lg:grid-cols-2">
            <Section title="Top workspaces" hint="By cost in the period.">
              <Table
                head={[
                  <th key="w">Workspace</th>,
                  <th key="ch" className="num">
                    Chats
                  </th>,
                  <th key="c" className="num">
                    Cost
                  </th>,
                ]}
                empty={d.topWorkspaces.length ? undefined : "No usage in this period."}
              >
                {d.topWorkspaces.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link href={`/admin/workspaces/${w.id}${q}`} className="font-medium hover:underline">
                        {w.name}
                      </Link>
                    </td>
                    <td className="num">{fmtNum(w.usage.chats)}</td>
                    <td className="num font-medium">{fmtUsd(w.usage.costUsd)}</td>
                  </tr>
                ))}
              </Table>
            </Section>
            <Section title="Top users" hint="By cost in the period, across their workspaces.">
              <Table
                head={[
                  <th key="u">User</th>,
                  <th key="ch" className="num">
                    Chats
                  </th>,
                  <th key="c" className="num">
                    Cost
                  </th>,
                ]}
                empty={d.topUsers.length ? undefined : "No usage in this period."}
              >
                {d.topUsers.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Person name={u.name} email={u.email} href={`/admin/users/${u.id}${q}`} />
                    </td>
                    <td className="num">{fmtNum(u.usage.chats)}</td>
                    <td className="num font-medium">{fmtUsd(u.usage.costUsd)}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          </div>

          <Section title="Newest users">
            <Table
              head={[<th key="u">User</th>, <th key="w">Workspaces</th>, <th key="j">Joined</th>]}
              empty={d.newestUsers.length ? undefined : "No users yet."}
            >
              {d.newestUsers.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Person name={u.name} email={u.email} href={`/admin/users/${u.id}${q}`} />
                  </td>
                  <td className="text-muted-foreground">{u.workspaces.join(", ") || "None"}</td>
                  <td className="whitespace-nowrap text-muted-foreground">{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <Link href="/admin/users" className="mt-2 inline-block text-sm text-muted-foreground hover:text-foreground">
              All users
            </Link>
          </Section>
        </div>
      </main>
    </div>
  );
}
