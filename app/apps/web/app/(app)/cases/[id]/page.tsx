import { Pencil } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { orNotFound, serverApi } from "../../../../trpc/server";
import { CaseFiles } from "./case-files";

// /cases/<id>: the case workspace. Its facts on top, then its files grouped by category, where they are uploaded,
// followed while they are processed, opened, retried and deleted.
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const [c, files] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.case.files({ caseId: id })),
  ]);
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Cases", href: "/cases" }, { label: c.title }]}>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/cases/${c.id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      </PageHeader>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{c.title}</h1>
          {c.facts ? (
            <p className="mt-3 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground line-clamp-6">
              {c.facts}
            </p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No facts yet.{" "}
              <Link href={`/cases/${c.id}/edit`} className="text-primary underline underline-offset-2">
                Add them
              </Link>
            </p>
          )}
          <CaseFiles caseId={c.id} initial={files} />
        </div>
      </main>
    </div>
  );
}
