import { CaseForm } from "@/components/case-form";
import { PageHeader } from "@/components/page-header";
import { Separator } from "@/components/ui/separator";
import { orNotFound, serverApi } from "@/trpc/server";
import { DeleteCase } from "./delete-case";

export default async function EditCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await orNotFound((await serverApi()).case.open({ caseId: id }));
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: c.title, href: `/cases/${c.id}` }, { label: "Settings" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
          <h1 className="mb-8 font-serif text-3xl font-semibold tracking-tight">Case settings</h1>
          <CaseForm initial={c} />
          <Separator className="my-10" />
          <section className="flex flex-col gap-3 rounded-xl border border-destructive/30 p-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <h2 className="text-sm font-medium">Delete this case</h2>
              <p className="text-sm text-muted-foreground">
                Its files and chats are deleted with it. This cannot be undone.
              </p>
            </div>
            <DeleteCase id={c.id} title={c.title} />
          </section>
        </div>
      </main>
    </div>
  );
}
