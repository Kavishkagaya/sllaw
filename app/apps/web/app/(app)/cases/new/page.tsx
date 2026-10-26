import { CaseForm } from "@/components/case-form";
import { PageHeader } from "@/components/page-header";

export default function NewCasePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Cases", href: "/cases" }, { label: "New case" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">New case</h1>
          <p className="mt-1 mb-8 text-sm text-muted-foreground">
            Give it a title and the facts. You add its files on the next page.
          </p>
          <CaseForm />
        </div>
      </main>
    </div>
  );
}
