import { Briefcase, FileText, Plus } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "@/lib/format";
import { serverApi } from "../../../trpc/server";

// /cases: the user's cases as cards, newest first, and the way to a new one.
export default async function CasesPage() {
  const cases = await (await serverApi()).case.list();
  return (
    <div className="flex h-full flex-col">
      <PageHeader crumbs={[{ label: "Cases" }]}>
        {cases.length > 0 && (
          <Button asChild size="sm">
            <Link href="/cases/new">
              <Plus /> New case
            </Link>
          </Button>
        )}
      </PageHeader>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Cases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each case keeps its files together: the AI reads them as the case's context.
          </p>
          {cases.length === 0 ? (
            <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
              <Briefcase className="size-8 text-muted-foreground" />
              <p className="font-medium">No cases yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create a case with its facts, then add its plaints, affidavits, judgments and other files.
              </p>
              <Button asChild className="mt-2">
                <Link href="/cases/new">
                  <Plus /> New case
                </Link>
              </Button>
            </div>
          ) : (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cases.map((c) => (
                <Link key={c.id} href={`/cases/${c.id}`} className="group rounded-xl focus-visible:outline-none">
                  <Card className="h-full transition-colors group-hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                    <CardHeader>
                      <CardTitle className="font-serif text-lg leading-snug">{c.title}</CardTitle>
                      <CardDescription className="line-clamp-3">
                        {c.facts || <span className="italic">No facts written yet</span>}
                      </CardDescription>
                    </CardHeader>
                    <CardFooter className="mt-auto justify-between gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="size-3.5" />
                        {c.files} {c.files === 1 ? "file" : "files"}
                      </span>
                      <span>Created {fmtDate(c.createdAt)}</span>
                    </CardFooter>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
