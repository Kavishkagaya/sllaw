import { cn } from "@/lib/utils";

export type Counts = { acts: number; chapters: number; amendments: number; updated: string | null } | null;

const n = (v: number | undefined) => (v == null ? "—" : v.toLocaleString("en-GB"));
export const fmtUpdated = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Colombo",
      })
    : "—";

/** The corpus counts, live from kb (corpus.coverage, cached an hour): four cells on the ink band. */
export function CoverageStats({ counts, className }: { counts: Counts; className?: string }) {
  const cells = [
    [n(counts?.acts), "Acts and Laws"],
    [n(counts?.chapters), "Revised Edition chapters"],
    [n(counts?.amendments), "Amendments followed"],
    [fmtUpdated(counts?.updated), "Last updated"],
  ];
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#3a362e] bg-[#3a362e]",
        className,
      )}
    >
      {cells.map(([v, label], i) => (
        <div key={label} className="flex flex-col-reverse bg-[#16140f] p-5">
          <dt className="mt-1 text-[13.5px] text-[#b8b1a4]">{label}</dt>
          <dd className={cn("font-mono text-2xl sm:text-[30px]", i === 3 && "text-[#e6a9b3]")}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
