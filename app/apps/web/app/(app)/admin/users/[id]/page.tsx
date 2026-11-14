import Link from "next/link";
import { Breakdown, PeriodRange, PeriodTabs, periodParam, Section, Stat, Table } from "@/components/admin/parts";
import { UserLimits } from "@/components/admin/user-limits";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtNum, fmtSize, fmtUsd } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// /admin/users/<id>: one user: their workspaces, and what they used over the period, per kind and per workspace.
export default async function AdminUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const period = periodParam(sp.period);
  const u = await orNotFound((await serverApi()).admin.user({ id, period }));
  const q = period === "month" ? "" : `?period=${period}`;
  const name = u.user.name || u.user.email || "Unknown user";
  const sum = (k: "chats" | "llmCalls" | "files") => u.workspaces.reduce((s, w) => s + w.usage[k], 0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Admin" }, { label: "Users", href: `/admin/users${q}` }, { label: name }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
                {u.user.isAdmin && <Badge variant="secondary">Admin</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {u.user.name && u.user.email ? `${u.user.email} · ` : ""}joined {fmtDate(u.user.createdAt)} ·{" "}
                {u.user.cases} cases · {u.user.chats} chats in all
              </p>
              <PeriodRange from={u.from} to={u.to} />
            </div>
            <PeriodTabs base={`/admin/users/${id}`} current={period} />
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cost" value={fmtUsd(u.total)} />
            <Stat label="Chats" value={fmtNum(sum("chats"))} />
            <Stat label="Model calls" value={fmtNum(sum("llmCalls"))} />
            <Stat label="Files processed" value={fmtNum(sum("files"))} />
          </div>

          <UserLimits userId={id} />

          <Section title="Workspaces" hint="Their role in each, and what they used there.">
            <Table
              head={[
                <th key="w">Workspace</th>,
                <th key="r">Role</th>,
                <th key="ch" className="num">
                  Chats
                </th>,
                <th key="f" className="num">
                  Files
                </th>,
                <th key="up" className="num">
                  Uploaded
                </th>,
                <th key="c" className="num">
                  Cost
                </th>,
              ]}
              empty={u.workspaces.length ? undefined : "In no workspace."}
            >
              {u.workspaces.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link href={`/admin/workspaces/${w.id}${q}`} className="font-medium hover:underline">
                      {w.name}
                    </Link>
                  </td>
                  <td className="text-muted-foreground">{w.role}</td>
                  <td className="num">{fmtNum(w.usage.chats)}</td>
                  <td className="num">{fmtNum(w.usage.files)}</td>
                  <td className="num">{fmtSize(w.usage.uploadedBytes)}</td>
                  <td className="num font-medium">{fmtUsd(w.usage.costUsd)}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="Model spend per file" hint="Reading their files (type, card, re-typing), per file.">
            <Table
              head={[
                <th key="f">File</th>,
                <th key="t">Tasks</th>,
                <th key="n" className="num">
                  Model calls
                </th>,
                <th key="c" className="num">
                  Cost
                </th>,
              ]}
              empty={u.files.length ? undefined : "No files read in this period."}
            >
              {u.files.map((f) => (
                <tr key={f.fileId}>
                  <td className="max-w-72 truncate font-medium" title={f.name ?? f.fileId}>
                    {f.name ?? <span className="text-muted-foreground">Deleted file</span>}
                  </td>
                  <td className="text-muted-foreground">{f.tasks.join(", ")}</td>
                  <td className="num">{fmtNum(f.calls)}</td>
                  <td className="num font-medium">
                    {fmtUsd(f.costUsd)}
                    {f.estimated && <span className="ml-1 text-xs text-muted-foreground">est.</span>}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="What was used" hint="Per kind of call, task and model.">
            <Breakdown rows={u.breakdown} />
          </Section>
        </div>
      </main>
    </div>
  );
}
