import Link from "next/link";
import { PeriodTabs, Person, periodParam, Table } from "@/components/admin/parts";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtNum, fmtUsd } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /admin/users: every user, their workspaces and role in each, and what they used over the period.
export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const period = periodParam((await searchParams).period);
  const { users } = await orNotFound((await serverApi()).admin.users({ period }));
  const q = period === "month" ? "" : `?period=${period}`;
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Admin" }, { label: "Users" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-3xl font-semibold tracking-tight">Users</h1>
              <p className="text-sm text-muted-foreground">
                {users.length} {users.length === 1 ? "user" : "users"}. Cost and chats are for the period.
              </p>
            </div>
            <PeriodTabs base="/admin/users" current={period} />
          </div>
          <div className="mt-6">
            <Table
              head={[
                <th key="u">User</th>,
                <th key="w">Workspaces</th>,
                <th key="c" className="num">
                  Cases
                </th>,
                <th key="j">Joined</th>,
                <th key="ch" className="num">
                  Chats
                </th>,
                <th key="cost" className="num">
                  Cost
                </th>,
              ]}
              empty={users.length ? undefined : "No users yet."}
            >
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Person name={u.name} email={u.email} href={`/admin/users/${u.id}${q}`} />
                      {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                    </div>
                  </td>
                  <td>
                    {u.workspaces.length ? (
                      <ul className="space-y-0.5">
                        {u.workspaces.map((w) => (
                          <li key={w.id}>
                            <Link href={`/admin/workspaces/${w.id}${q}`} className="hover:underline">
                              {w.name}
                            </Link>{" "}
                            <span className="text-xs text-muted-foreground">{w.role}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </td>
                  <td className="num">{u.cases}</td>
                  <td className="whitespace-nowrap text-muted-foreground">{fmtDate(u.createdAt)}</td>
                  <td className="num">{fmtNum(u.usage.chats)}</td>
                  <td className="num font-medium">{fmtUsd(u.usage.costUsd)}</td>
                </tr>
              ))}
            </Table>
          </div>
        </div>
      </main>
    </div>
  );
}
