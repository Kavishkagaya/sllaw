import { db } from "@/lib/db";
import { documents, chunks } from "@/lib/schema";
import type { QaReport } from "@/lib/schema";
import { eq, asc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";

const KIND_STYLE: Record<string, string> = {
  preamble: "bg-purple-100 text-purple-800",
  part: "bg-blue-100 text-blue-800",
  chapter: "bg-indigo-100 text-indigo-800",
  section: "bg-gray-100 text-gray-700",
  schedule: "bg-teal-100 text-teal-800",
};

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const docId = parseInt(id, 10);
  if (Number.isNaN(docId)) notFound();

  const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
  if (!doc) notFound();

  const rows = await db
    .select()
    .from(chunks)
    .where(eq(chunks.documentId, docId))
    .orderBy(asc(chunks.idx));

  const meta = (doc.meta ?? {}) as Record<string, string>;
  const qa = (doc.qa ?? {}) as QaReport;
  // the PDF is deleted once it passes QA, but source_url still resolves, so the
  // proxy can always fetch it fresh
  const pdf = doc.kind === "pdf" ? `/api/pdf?url=${encodeURIComponent(doc.sourceUrl)}` : null;

  return (
    <main className="flex flex-col h-screen">
      <header className="shrink-0 border-b border-gray-200 px-6 py-3">
        <Link href="/" className="text-xs text-blue-600">← All documents</Link>
        <h1 className="text-lg font-semibold text-gray-900 mt-1">
          {doc.title || meta.description || doc.sourceUrl}
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          {meta.act_no && <>No. {meta.act_no} · </>}
          {doc.source} · {doc.kind} · {rows.length} chunks · {doc.status}
          {qa.coverage != null && <> · coverage {Math.round(qa.coverage * 100)}%</>}
        </p>
        {qa.flags?.length ? (
          <p className="text-xs text-amber-700 mt-1">flags: {qa.flags.join(", ")}</p>
        ) : null}
        {doc.error && <p className="text-xs text-red-700 mt-1">{doc.error}</p>}
      </header>

      <div className="flex-1 flex min-h-0">
        {pdf && (
          <iframe src={pdf} className="w-1/2 border-r border-gray-200" title="source PDF" />
        )}
        <div className={`${pdf ? "w-1/2" : "w-full"} overflow-y-auto`}>
          {rows.length === 0 && (
            <p className="p-6 text-sm text-gray-500">
              No chunks — this document was not extracted.
            </p>
          )}
          {rows.map((c) => (
            <article key={c.id} className="border-b border-gray-100 px-6 py-4">
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  KIND_STYLE[c.kind] ?? "bg-gray-100 text-gray-700"}`}>
                  {c.kind}
                </span>
                {c.anchor && (
                  <span className="text-xs font-semibold text-gray-900">{c.anchor}</span>
                )}
                {c.pages?.length ? (
                  <span className="text-xs text-gray-400">p. {c.pages.join(", ")}</span>
                ) : null}
              </div>
              {c.note && (
                <p className="text-xs font-medium text-gray-600 mb-1">{c.note}</p>
              )}
              <p className="text-[11px] text-gray-400 mb-2 truncate">{c.breadcrumb}</p>
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {c.text}
              </p>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
