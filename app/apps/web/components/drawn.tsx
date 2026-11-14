// Line drawings for empty states and the 404 (d2): one stroke weight in ink, the oxblood for one accent, over a patch
// of the dot field. Decorative: hidden from screen readers.
import { cn } from "@/lib/utils";

/** Fanned papers with a law chip: no cases, no files, no sources yet. */
export function PapersDrawing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 96" aria-hidden className={cn("h-24 w-30 text-foreground", className)}>
      <defs>
        <pattern id="drawn-dots" width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="1" className="fill-primary" opacity=".28" />
        </pattern>
      </defs>
      <circle cx="60" cy="52" r="40" fill="url(#drawn-dots)" />
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M30 26l30-6 6 50-30 6z" className="fill-card" transform="rotate(-6 45 50)" />
        <path d="M50 18h30l10 10v50H50z" className="fill-card" />
        <path d="M80 18v10h10" />
        <path d="M58 40h24M58 48h24M58 56h16" opacity=".5" />
      </g>
      <rect x="57" y="62" width="22" height="8" rx="2" className="fill-law stroke-primary" strokeWidth="1.4" />
    </svg>
  );
}

/** The arch, drawn large and dotted: nothing here (the 404). */
export function ArchDrawing({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={cn("size-32 text-primary", className)}>
      <path
        d="M24 82V46a24 24 0 0 1 48 0v36"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="2 7"
      />
      <path d="M12 82h72" className="stroke-foreground" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
