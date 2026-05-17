import { db } from "@/lib/db";
import { acts, parts, sections } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import DocViewer from "@/app/components/DocViewer";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ActPage({ params }: PageProps) {
  const { id } = await params;
  const actId = parseInt(id);
  if (isNaN(actId)) notFound();

  const [act] = await db.select().from(acts).where(eq(acts.id, actId)).limit(1);
  if (!act) notFound();

  const actParts = await db
    .select()
    .from(parts)
    .where(eq(parts.actId, actId))
    .orderBy(parts.id);

  const actSections = await db
    .select()
    .from(sections)
    .where(eq(sections.actId, actId))
    .orderBy(sections.sectionNumber);

  // Build the JSON to display: prefer raw_json, fall back to structured DB data
  const docJson = act.rawJson ?? {
    title: act.title || act.description,
    act_number: act.actNumber,
    year: act.year,
    certified: act.certified || act.certifiedDate,
    total_pages: act.totalPages,
    parts: actParts.map((p) => ({
      number: p.partNumber,
      title: p.title,
      type: p.partType,
      sections: p.sectionNumbers,
    })),
    sections: Object.fromEntries(
      actSections.map((s) => [
        s.sectionNumber,
        { number: s.sectionNumber, short_title: s.shortTitle, part: s.partNumber, body: s.body },
      ])
    ),
  };

  const pdfUrl = act.pdfUrl
    ? `/api/pdf?url=${encodeURIComponent(act.pdfUrl)}`
    : null;

  const displayTitle = act.title || act.description || act.actNumber;

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 bg-white border-b border-gray-200">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-900 transition-colors shrink-0">
          ← Back
        </Link>
        <span className="text-gray-200">|</span>
        <h1 className="text-sm font-semibold text-gray-900 truncate">
          {displayTitle}
          <span className="text-gray-400 font-normal ml-2">
            No. {act.actNumber} · {act.year}
          </span>
        </h1>
      </div>
      <div className="flex-1 min-h-0">
        <DocViewer data={docJson} pdfUrl={pdfUrl} />
      </div>
    </div>
  );
}
