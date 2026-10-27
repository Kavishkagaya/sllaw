import { notFound } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { serverApi } from "@/trpc/server";

// /doc/act:9/2023#c123: a law in full, each chunk anchored by id so citations open at it.
export default async function DocPage({ params }: { params: Promise<{ key: string[] }> }) {
  const key = (await params).key.map(decodeURIComponent).join("/");
  const doc = await (await serverApi()).corpus.doc({ key });
  if (!doc) notFound();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="truncate text-sm font-medium">{doc.title ?? doc.key}</span>
      </header>
      <main className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="font-serif text-3xl leading-tight font-semibold">{doc.title ?? doc.key}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {doc.key}
            {doc.commenced ? ` · commenced ${doc.commenced}` : ""}
          </p>
          <Separator className="my-6" />
          {doc.chunks.map((c) => (
            <section
              key={c.id}
              id={`c${c.id}`}
              className="scroll-mt-4 rounded-md px-3 py-3 target:bg-brass/10 target:ring-1 target:ring-brass/40"
            >
              {c.path && <p className="mb-1 text-xs text-muted-foreground">{c.path}</p>}
              <div className="font-serif leading-relaxed whitespace-pre-wrap">{c.text}</div>
            </section>
          ))}
        </article>
      </main>
    </div>
  );
}
