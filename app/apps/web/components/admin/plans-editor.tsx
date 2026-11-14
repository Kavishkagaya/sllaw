"use client";
// /admin/plans: every plan with its max per metric, edited in place (saved on blur), the default marked, new plans.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { Section } from "@/components/admin/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/trpc/client";
import { LimitInput } from "./limit-input";

export function PlansEditor() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.admin.plans.list.queryOptions());
  const done = { onSuccess: () => qc.invalidateQueries({ queryKey: trpc.admin.plans.list.queryKey() }) };
  const setLimit = useMutation(trpc.admin.plans.setLimit.mutationOptions(done));
  const setDefault = useMutation(trpc.admin.plans.setDefault.mutationOptions(done));
  const remove = useMutation(trpc.admin.plans.remove.mutationOptions(done));
  const save = useMutation(trpc.admin.plans.save.mutationOptions(done));
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const error = setLimit.error ?? setDefault.error ?? remove.error ?? save.error;

  if (list.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (list.isError) return <p className="text-sm text-destructive">Could not load plans: {list.error.message}</p>;
  const { plans, metrics } = list.data;
  return (
    <div className="grid gap-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {plans.map((p) => (
          <Card key={p.id}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-xl">{p.name}</CardTitle>
                <code className="text-xs text-muted-foreground">{p.key}</code>
                {p.isDefault && <Badge>Default</Badge>}
              </div>
              {!p.isDefault && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDefault.mutate({ id: p.id })}>
                    <Star /> Make default
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${p.name}`}
                    onClick={() =>
                      confirm(`Delete the ${p.name} plan? Users on it move to the default plan.`) &&
                      remove.mutate({ id: p.id })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm [&_td]:py-1.5">
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.metric} className="border-b last:border-0">
                      <td>
                        <div className="font-medium">{m.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.kind === "counter" ? `resets every ${m.per}` : `what exists now, per ${m.per}`}
                        </div>
                      </td>
                      <td className="flex justify-end">
                        <LimitInput
                          unit={m.unit}
                          value={p.limits[m.metric] ?? null}
                          onSave={(max) => setLimit.mutate({ planId: p.id, metric: m.metric, max })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
      </div>
      <Section title="New plan" hint="A key (lower case, no spaces) and a name. Its limits start empty: no limit.">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { key, name },
              {
                onSuccess: () => {
                  setKey("");
                  setName("");
                },
              },
            );
          }}
        >
          <Input className="w-40" placeholder="pro" value={key} onChange={(e) => setKey(e.target.value)} />
          <Input className="w-56" placeholder="Pro" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={!key || !name || save.isPending}>
            <Plus /> Add plan
          </Button>
        </form>
      </Section>
    </div>
  );
}
