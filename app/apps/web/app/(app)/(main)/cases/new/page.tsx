import { AccountPending } from "@/components/account-pending";
import { NewCase } from "@/components/new-case";
import { PageHeader } from "@/components/page-header";
import { serverApi } from "@/trpc/server";

// New case, and a new lawyer's first screen after sign-up (no profile questions: docs/features/onboarding.json).
export default async function NewCasePage() {
  // a new lawyer lands here straight from sign-up, maybe before the account is synced: wait for it
  const cases = await (await serverApi()).case.list().catch((e: { code?: string }) => {
    if (e?.code === "PRECONDITION_FAILED") return null;
    throw e;
  });
  const first = !cases?.length;
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Cases", href: "/cases" }, { label: "New case" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-semibold tracking-tight">
            {first ? "Let's set up your first case" : "New case"}
          </h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">
            Tell us about it in your own words, or drop its files. We read them, you check what we found, and the case
            opens with a first brief.
          </p>
          {cases ? <NewCase /> : <AccountPending />}
        </div>
      </main>
    </div>
  );
}
