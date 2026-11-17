import { notFound } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isJudgment, lawName, prose } from "@/lib/law";
import { serverApi } from "@/trpc/server";
import { DocView } from "./doc-view";

// /doc/act:9/2023#c123: a law in full, each chunk anchored by id so citations open at it, beside the PDF or HTML page
// it was built from as we stored it (not the official site's copy).
export default async function DocPage({ params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  const api = await serverApi();
  const [doc, source] = await Promise.all([api.corpus.doc({ key }), api.corpus.source({ key })]);
  if (!doc) notFound();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="truncate text-sm font-medium">{doc.title ?? doc.key}</span>
      </header>
      <DocView
        source={source}
        text={
          <article className="mx-auto max-w-3xl px-6 py-10">
            <h1 className="text-3xl leading-tight font-semibold">{doc.title ?? doc.key}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {isJudgment(doc.key) ? lawName(doc.key) : doc.key}
              {doc.commenced ? ` · commenced ${doc.commenced}` : ""}
            </p>
            <Separator className="my-6" />
            {doc.chunks.map((c) => (
              <section
                key={c.id}
                id={`c${c.id}`}
                className="scroll-mt-4 rounded-md px-3 py-3 data-cited:bg-law-mark data-cited:ring-1 data-cited:ring-law-border"
              >
                {c.path && <p className="mb-1 text-xs text-muted-foreground">{c.path}</p>}
                <div className="font-law leading-relaxed whitespace-pre-wrap">
                  {isJudgment(doc.key) ? prose(c.text) : c.text}
                </div>
              </section>
            ))}
          </article>
        }
      />
    </div>
  );
}
