"use client";
// A user's plan and limits on /admin/users/<id>: their usage against each limit, the plan they are on (give one with
// an end date, end one), and their own limits, which replace the plan's until they expire.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Section, Table } from "@/components/admin/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UsageView } from "@/components/usage/usage-view";
import { fmtDate } from "@/lib/format";
import { useTRPC } from "@/trpc/client";
import { fromInput, toInput, unitHint } from "./limit-input";

const select = "h-9 rounded-md border bg-background px-2 text-sm";
const dateOrNull = (s: string) => (s ? new Date(`${s}T23:59:59+05:30`) : null); // the end of that Colombo day

export function UserLimits({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.admin.limits.user.queryOptions({ userId }));
  const plans = useQuery(trpc.admin.plans.list.queryOptions());
  const done = { onSuccess: () => qc.invalidateQueries({ queryKey: trpc.admin.limits.user.queryKey({ userId }) }) };
  const give = useMutation(trpc.admin.limits.givePlan.mutationOptions(done));
  const end = useMutation(trpc.admin.limits.endPlan.mutationOptions(done));
  const setOwn = useMutation(trpc.admin.limits.setUserLimit.mutationOptions(done));
  const removeOwn = useMutation(trpc.admin.limits.removeUserLimit.mutationOptions(done));
  const [plan, setPlan] = useState({ planId: "", endsAt: "", note: "" });
  const [own, setOwnForm] = useState({ metric: "messages", max: "", expiresAt: "", note: "" });
  const error = give.error ?? end.error ?? setOwn.error ?? removeOwn.error;

  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading limits…</p>;
  if (q.isError) return <p className="text-sm text-destructive">Could not load limits: {q.error.message}</p>;
  const s = q.data;
  const planName = (id: string) => plans.data?.plans.find((p) => p.id === id)?.name ?? "Deleted plan";
  const now = Date.now();
  const unitOf = (m: string) => s.limits.find((l) => l.metric === m)?.unit ?? "count";
  const metric = (m: string) => m as (typeof s.limits)[number]["metric"]; // a stored row's metric, one of these
  const label = (m: string) => s.limits.find((l) => l.metric === m)?.label ?? m;

  return (
    <>
      {error && <p className="mt-4 text-sm text-destructive">{error.message}</p>}
      <Section title="Plan" hint="The newest active plan applies; with none, the default plan.">
        <p className="mb-3 text-sm">
          On <Badge variant="secondary">{s.plan?.name ?? "no plan"}</Badge>
        </p>
        <Table
          head={[
            <th key="p">Plan</th>,
            <th key="f">From</th>,
            <th key="t">Until</th>,
            <th key="n">Note</th>,
            <th key="a" />,
          ]}
          empty={s.history.length ? undefined : "No plan given: on the default plan."}
        >
          {s.history.map((h) => {
            const active = +new Date(h.startsAt) <= now && (!h.endsAt || +new Date(h.endsAt) > now);
            return (
              <tr key={h.id} className={active ? "" : "text-muted-foreground"}>
                <td className="font-medium">
                  {planName(h.planId)} {active && <Badge variant="outline">active</Badge>}
                </td>
                <td>{fmtDate(h.startsAt)}</td>
                <td>{h.endsAt ? fmtDate(h.endsAt) : "no end"}</td>
                <td className="text-muted-foreground">{h.note}</td>
                <td className="text-right">
                  {active && (
                    <Button size="sm" variant="ghost" onClick={() => end.mutate({ userId, id: h.id })}>
                      End now
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            give.mutate(
              { userId, planId: plan.planId, endsAt: dateOrNull(plan.endsAt), note: plan.note || null },
              { onSuccess: () => setPlan({ planId: "", endsAt: "", note: "" }) },
            );
          }}
        >
          <select
            className={select}
            value={plan.planId}
            onChange={(e) => setPlan({ ...plan, planId: e.target.value })}
            aria-label="Plan"
          >
            <option value="">Give a plan…</option>
            {plans.data?.plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            until
            <Input
              type="date"
              aria-label="Until"
              className="w-40"
              value={plan.endsAt}
              onChange={(e) => setPlan({ ...plan, endsAt: e.target.value })}
            />
          </span>
          <Input
            className="w-56"
            placeholder="Note (why)"
            value={plan.note}
            onChange={(e) => setPlan({ ...plan, note: e.target.value })}
          />
          <Button type="submit" disabled={!plan.planId || give.isPending}>
            Give plan
          </Button>
        </form>
      </Section>

      <Section title="Own limits" hint="Replace the plan's limit for this user until they expire. Empty max: no limit.">
        <Table
          head={[
            <th key="m">Limit</th>,
            <th key="x" className="num">
              Max
            </th>,
            <th key="e">Expires</th>,
            <th key="n">Note</th>,
            <th key="a" />,
          ]}
          empty={s.own.length ? undefined : "None: the plan's limits apply."}
        >
          {s.own.map((l) => {
            const expired = l.expiresAt && +new Date(l.expiresAt) <= now;
            return (
              <tr key={l.metric} className={expired ? "text-muted-foreground" : ""}>
                <td className="font-medium">
                  {label(l.metric)} {expired && <Badge variant="outline">expired</Badge>}
                </td>
                <td className="num">
                  {l.max == null ? "No limit" : `${toInput(unitOf(l.metric), l.max)} ${unitHint(unitOf(l.metric))}`}
                </td>
                <td>{l.expiresAt ? fmtDate(l.expiresAt) : "never"}</td>
                <td className="text-muted-foreground">{l.note}</td>
                <td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeOwn.mutate({ userId, metric: metric(l.metric) })}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            );
          })}
        </Table>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const max = fromInput(unitOf(own.metric), own.max);
            if (max === undefined) return;
            setOwn.mutate(
              {
                userId,
                metric: metric(own.metric),
                max,
                expiresAt: dateOrNull(own.expiresAt),
                note: own.note || null,
              },
              { onSuccess: () => setOwnForm({ ...own, max: "", expiresAt: "", note: "" }) },
            );
          }}
        >
          <select
            className={select}
            value={own.metric}
            onChange={(e) => setOwnForm({ ...own, metric: e.target.value })}
            aria-label="Limit"
          >
            {s.limits.map((l) => (
              <option key={l.metric} value={l.metric}>
                {l.label}
              </option>
            ))}
          </select>
          <Input
            inputMode="numeric"
            className="w-32 text-right"
            placeholder="No limit"
            value={own.max}
            onChange={(e) => setOwnForm({ ...own, max: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">{unitHint(unitOf(own.metric))}</span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            until
            <Input
              type="date"
              aria-label="Until"
              className="w-40"
              value={own.expiresAt}
              onChange={(e) => setOwnForm({ ...own, expiresAt: e.target.value })}
            />
          </span>
          <Input
            className="w-56"
            placeholder="Note (why)"
            value={own.note}
            onChange={(e) => setOwnForm({ ...own, note: e.target.value })}
          />
          <Button type="submit" disabled={setOwn.isPending}>
            Set limit
          </Button>
        </form>
      </Section>

      <Section title="Usage against limits" hint="Today and this month, across all their workspaces.">
        <UsageView s={s} />
      </Section>
    </>
  );
}
