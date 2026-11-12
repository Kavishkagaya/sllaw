// A user's limits and their spend: the /usage page (spend as percent of the allowance, never money) and the user's
// section on /admin/users/<id> (USD). The allowance first (today, this month, per day), then the other limits.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtNum } from "@/lib/format";
import { ContextChart } from "./context-chart";
import { Meter, type Unit } from "./meter";

export type Limit = {
  metric: string;
  label: string;
  unit: Unit;
  per: string;
  kind: string;
  used: number | null;
  max: number | null;
  source: "user" | "plan";
  resetsAt: Date | null;
};
export type Status = {
  plan: { key: string; name: string } | null;
  money: boolean;
  limits: Limit[];
  days: { day: string; spend: number; messages: number }[];
};

export function UsageView({ s }: { s: Status }) {
  const by = (m: string) => s.limits.find((l) => l.metric === m);
  const today = by("spend");
  const month = by("spend_month");
  const rest = s.limits.filter((l) => !l.metric.startsWith("spend"));
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-xl">{s.money ? "Model spend" : "Allowance"}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {s.money
              ? "What the gateway billed for their model calls: chat, reading their files, re-typing a file."
              : "The assistant's work for you: answering your questions and reading the files you add to your cases."}
          </p>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-6 md:grid-cols-2">
            {today && (
              <Meter
                big
                label="Today"
                used={today.used ?? 0}
                max={today.max}
                unit={today.unit}
                per="day"
                resetsAt={today.resetsAt}
              />
            )}
            {month && (
              <Meter
                big
                label="This month"
                used={month.used ?? 0}
                max={month.max}
                unit={month.unit}
                per="month"
                resetsAt={month.resetsAt}
              />
            )}
          </div>
          <div>
            <h3 className="mb-5 text-sm font-medium">Per day this month</h3>
            {s.days.length ? (
              <ContextChart days={s.days} limit={today?.max ?? null} money={s.money} />
            ) : (
              <p className="text-sm text-muted-foreground">No daily limit on your plan.</p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-xl">Other limits</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-2">
          {rest.map((l) =>
            l.used == null ? (
              <div key={l.metric} className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{l.label}</span>
                <span className="text-muted-foreground">{l.max == null ? "No limit" : `Up to ${fmtNum(l.max)}`}</span>
              </div>
            ) : (
              <Meter
                key={l.metric}
                label={l.label}
                used={l.used}
                max={l.max}
                unit={l.unit}
                per={l.per}
                resetsAt={l.resetsAt}
              />
            ),
          )}
        </CardContent>
      </Card>
    </div>
  );
}
