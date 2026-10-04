import { db } from "@/lib/db";
import { documents } from "@/lib/schema";
import type { QaReport } from "@/lib/schema";
import { and, or, eq, ilike, sql, desc } from "drizzle-orm";
import Link from "next/link";

const PAGE_SIZE = 60;

const STATUS_STYLE: Record<string, string> = {
  qa_pass: "bg-green-100 text-green-800",
  qa_flagged: "bg-amber-100 text-amber-800",
  ocr_pending: "bg-slate-200 text-slate-700",
  error: "bg-red-100 text-red-800",
};

interface PageProps {
  searchParams: Promise<{ q?: string; status?: string; source?: string; page?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const { q = "", status = "", source = "", page = "1" } = await searchParams;
  const pageNum = Math.max(1, parseInt(page) || 1);

  const where = and(
    q
      ? or(
          ilike(documents.title, `%${q}%`),
          sql`${documents.meta}->>'description' ILIKE ${"%" + q + "%"}`,
          sql`${documents.meta}->>'act_no' ILIKE ${"%" + q + "%"}`
        )
      : undefined,
    status ? eq(documents.status, status) : undefined,
    source ? eq(documents.source, source) : undefined
  );

  const [rows, [{ total }], counts] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(where)
      .orderBy(desc(documents.updatedAt))
      .limit(PAGE_SIZE)
      .offset((pageNum - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(documents).where(where),
    db
      .select({ status: documents.status, n: sql<number>`count(*)::int` })
      .from(documents)
      .groupBy(documents.status),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (o: Record<string, string>) => {
    const p = new URLSearchParams({ q, status, source, ...o });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/?${p}`;
  };

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Documents</h1>
        <p className="text-sm text-gray-500 mt-1">
          {total.toLocaleString()} documents
          {counts.map((c) => (
            <span key={c.status}> · {c.status} {c.n.toLocaleString()}</span>
          ))}
        </p>
      </header>

      <form className="flex flex-wrap gap-2 mb-6" action="/">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search title, act number, description…"
          className="flex-1 min-w-64 px-3 py-2 border border-gray-300 rounded text-sm"
        />
        <select name="status" defaultValue={status}
          className="px-3 py-2 border border-gray-300 rounded text-sm">
          <option value="">any status</option>
          {["qa_pass", "qa_flagged", "ocr_pending", "error"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select name="source" defaultValue={source}
          className="px-3 py-2 border border-gray-300 rounded text-sm">
          <option value="">any source</option>
          <option value="acts">acts</option>
          <option value="consolidated">consolidated</option>
        </select>
        <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm cursor-pointer">
          Search
        </button>
      </form>

      <div className="border border-gray-200 rounded divide-y divide-gray-100">
        {rows.length === 0 && (
          <p className="p-6 text-sm text-gray-500">No documents match.</p>
        )}
        {rows.map((d) => {
          const meta = (d.meta ?? {}) as Record<string, string>;
          const qa = (d.qa ?? {}) as QaReport;
          return (
            <Link key={d.id} href={`/document/${d.id}`}
              className="flex items-start gap-3 p-3 hover:bg-gray-50">
              <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${
                STATUS_STYLE[d.status] ?? "bg-gray-100 text-gray-700"}`}>
                {d.status}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-gray-900 truncate">
                  {d.title || meta.description || d.sourceUrl}
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {meta.act_no && <>No. {meta.act_no} · </>}
                  {d.source} · {d.kind} · {d.chunksCount} chunks
                  {qa.flags?.length ? (
                    <span className="text-amber-700"> · {qa.flags.join(", ")}</span>
                  ) : null}
                </span>
              </span>
            </Link>
          );
        })}
      </div>

      {pages > 1 && (
        <nav className="flex items-center justify-between mt-4 text-sm">
          {pageNum > 1
            ? <Link className="text-blue-600" href={qs({ page: String(pageNum - 1) })}>← Prev</Link>
            : <span />}
          <span className="text-gray-500">Page {pageNum} of {pages}</span>
          {pageNum < pages
            ? <Link className="text-blue-600" href={qs({ page: String(pageNum + 1) })}>Next →</Link>
            : <span />}
        </nav>
      )}
    </main>
  );
}
