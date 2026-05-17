import { db } from "@/lib/db";
import { consolidatedStatutes, consolidatedParts, consolidatedSections } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import DocViewer from "@/app/components/DocViewer";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StatutePage({ params }: PageProps) {
  const { id } = await params;
  const statuteId = parseInt(id);
  if (isNaN(statuteId)) notFound();

  const [statute] = await db
    .select()
    .from(consolidatedStatutes)
    .where(eq(consolidatedStatutes.id, statuteId))
    .limit(1);
  if (!statute) notFound();

  const statuteParts = await db
    .select()
    .from(consolidatedParts)
    .where(eq(consolidatedParts.statuteId, statuteId))
    .orderBy(consolidatedParts.id);

  const statuteSections = await db
    .select()
    .from(consolidatedSections)
    .where(eq(consolidatedSections.statuteId, statuteId))
    .orderBy(consolidatedSections.id);

  const docJson = statute.rawJson ?? {
    title: statute.title || statute.indexTitle,
    collection: statute.collection,
    source_type: statute.sourceType,
    enacted_date: statute.enactedDate,
    description: statute.description,
    parts: statuteParts.map((p) => ({
      number: p.partNumber,
      title: p.title,
      type: p.partType,
      sections: p.sectionNumbers,
    })),
    sections: Object.fromEntries(
      statuteSections.map((s) => [
        s.sectionNumber,
        { number: s.sectionNumber, short_title: s.shortTitle, part: s.partNumber, body: s.body },
      ])
    ),
  };

  // Only show PDF viewer if source is a PDF
  const pdfUrl =
    statute.sourceType === "pdf" && statute.sourceUrl
      ? `/api/pdf?url=${encodeURIComponent(statute.sourceUrl)}`
      : null;

  const displayTitle = statute.title || statute.indexTitle;

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 bg-white border-b border-gray-200">
        <Link
          href="/?tab=consolidated"
          className="text-sm text-gray-400 hover:text-gray-900 transition-colors shrink-0"
        >
          ← Back
        </Link>
        <span className="text-gray-200">|</span>
        <h1 className="text-sm font-semibold text-gray-900 truncate">
          {displayTitle}
          <span className="text-gray-400 font-normal ml-2">
            {statute.collection} · {statute.sourceType.toUpperCase()}
          </span>
        </h1>
      </div>
      <div className="flex-1 min-h-0">
        <DocViewer data={docJson} pdfUrl={pdfUrl} />
      </div>
    </div>
  );
}
