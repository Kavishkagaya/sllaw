import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { UsageView } from "@/components/usage/usage-view";
import { serverApi } from "@/trpc/server";

// /usage: the user's plan, how much of today's and this month's context they used, per day, and their other limits.
export default async function UsagePage() {
  const s = await (await serverApi()).usage.mine();
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Usage" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
            {s.plan && <Badge variant="secondary">{s.plan.name} plan</Badge>}
          </div>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">
            Daily limits reset at midnight, Sri Lanka time; monthly ones on the 1st.
          </p>
          <UsageView s={s} />
        </div>
      </main>
    </div>
  );
}
