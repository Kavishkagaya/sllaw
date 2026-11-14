import { PlansEditor } from "@/components/admin/plans-editor";
import { PageHeader } from "@/components/page-header";

// /admin/plans: plans and their limits. The admin layout already answers 404 to anyone but platform staff.
export default function AdminPlansPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Admin" }, { label: "Plans" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-semibold tracking-tight">Plans</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">
            Each user is on one plan (the default unless given another on their page). A limit applies to the user
            across all their workspaces; empty means no limit. Changes apply within a minute.
          </p>
          <PlansEditor />
        </div>
      </main>
    </div>
  );
}
