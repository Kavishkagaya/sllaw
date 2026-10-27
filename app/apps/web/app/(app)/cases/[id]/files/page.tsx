import { PageHeader } from "@/components/page-header";
import { orNotFound, serverApi } from "@/trpc/server";
import { CaseFiles } from "./case-files";

// /cases/<id>/files: the case's files grouped by category, where they are uploaded, followed while they are
// processed, opened, retried and deleted.
export default async function CaseFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const [c, files] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.case.files({ caseId: id })),
  ]);
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: c.title, href: `/cases/${c.id}` }, { label: "Files" }]} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <CaseFiles caseId={c.id} initial={files} />
        </div>
      </main>
    </div>
  );
}
