import { db } from "@/lib/db";
import { acts, consolidatedStatutes } from "@/lib/schema";
import { eq, and, or, ilike, asc } from "drizzle-orm";
import Link from "next/link";

const PAGE_SIZE = 60;

interface PageProps {
  searchParams: Promise<{ tab?: string; q?: string; page?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const { tab = "acts", q = "", page = "1" } = await searchParams;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const isConsolidated = tab === "consolidated";

  // ── Acts ───────────────────────────────────────────────────────────────
  const actSearch = q
    ? or(ilike(acts.title, `%${q}%`), ilike(acts.description, `%${q}%`))
    : undefined;

  const actRows = isConsolidated
    ? []
    : await db
        .select({
          id: acts.id,
          year: acts.year,
          actNumber: acts.actNumber,
          title: acts.title,
          description: acts.description,
          partsCount: acts.partsCount,
          sectionsCount: acts.sectionsCount,
        })
        .from(acts)
        .where(and(eq(acts.status, "extracted"), actSearch))
        .orderBy(asc(acts.year), asc(acts.actNumber))
        .limit(PAGE_SIZE)
        .offset(offset);

  // ── Consolidated statutes ──────────────────────────────────────────────
  const statSearch = q
    ? or(
        ilike(consolidatedStatutes.title, `%${q}%`),
        ilike(consolidatedStatutes.indexTitle, `%${q}%`)
      )
    : undefined;

  const statRows = !isConsolidated
    ? []
    : await db
        .select({
          id: consolidatedStatutes.id,
          collection: consolidatedStatutes.collection,
          sourceType: consolidatedStatutes.sourceType,
          indexTitle: consolidatedStatutes.indexTitle,
          title: consolidatedStatutes.title,
          partsCount: consolidatedStatutes.partsCount,
          sectionsCount: consolidatedStatutes.sectionsCount,
        })
        .from(consolidatedStatutes)
        .where(and(eq(consolidatedStatutes.status, "extracted"), statSearch))
        .orderBy(asc(consolidatedStatutes.indexTitle))
        .limit(PAGE_SIZE)
        .offset(offset);

  const rows = isConsolidated ? statRows : actRows;
  const hasNext = rows.length === PAGE_SIZE;

  function tabUrl(t: string) {
    const p = new URLSearchParams({ tab: t, ...(q ? { q } : {}) });
    return `/?${p}`;
  }
  function searchUrl(newQ: string) {
    const p = new URLSearchParams({ tab, ...(newQ ? { q: newQ } : {}) });
    return `/?${p}`;
  }
  function pageUrl(n: number) {
    const p = new URLSearchParams({ tab, ...(q ? { q } : {}), page: String(n) });
    return `/?${p}`;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Legal Documents</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-gray-200">
        {(["acts", "consolidated"] as const).map((t) => (
          <Link
            key={t}
            href={tabUrl(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t border-b-2 transition-colors ${
              tab === t
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t === "acts" ? "Acts" : "Consolidated Statutes"}
          </Link>
        ))}
      </div>

      {/* Search */}
      <form action="/" className="mb-5">
        <input type="hidden" name="tab" value={tab} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by title…"
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
        />
      </form>

      {/* List */}
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const isAct = !isConsolidated;
          const href = isAct ? `/act/${row.id}` : `/statute/${row.id}`;
          const label = isAct
            ? (row as typeof actRows[0]).title ||
              (row as typeof actRows[0]).description ||
              (row as typeof actRows[0]).actNumber
            : (row as typeof statRows[0]).title ||
              (row as typeof statRows[0]).indexTitle;
          const sub = isAct
            ? `Act No. ${(row as typeof actRows[0]).actNumber} · ${(row as typeof actRows[0]).year}`
            : `Collection ${(row as typeof statRows[0]).collection} · ${(row as typeof statRows[0]).sourceType.toUpperCase()}`;

          return (
            <Link
              key={row.id}
              href={href}
              className="flex items-center justify-between bg-white rounded-lg border border-gray-200 px-5 py-3.5 hover:border-blue-400 hover:shadow-sm transition-all group"
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                  {label}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
              </div>
              <div className="flex items-center gap-2 text-xs shrink-0 ml-4">
                {row.partsCount != null && (
                  <span className="text-gray-400">{row.partsCount}P / {row.sectionsCount}S</span>
                )}
                <span className="text-gray-300">→</span>
              </div>
            </Link>
          );
        })}

        {rows.length === 0 && (
          <p className="text-center text-gray-400 py-16">No documents found.</p>
        )}
      </div>

      {/* Pagination */}
      {(pageNum > 1 || hasNext) && (
        <div className="flex gap-3 justify-center mt-6 text-sm">
          {pageNum > 1 && (
            <Link href={pageUrl(pageNum - 1)} className="text-blue-600 hover:underline">
              ← Previous
            </Link>
          )}
          <span className="text-gray-400">Page {pageNum}</span>
          {hasNext && (
            <Link href={pageUrl(pageNum + 1)} className="text-blue-600 hover:underline">
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
