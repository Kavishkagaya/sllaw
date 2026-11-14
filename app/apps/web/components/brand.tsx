import { cn } from "@/lib/utils";

// Neethi (Sinhala නීති law, Tamil நீதி justice). The mark is one stroke: an arch, a court's doorway and a lowercase n,
// in oxblood (the theme's primary, so it lightens in dark). app/icon.svg is the same arch, white on an oxblood tile.
export const BRAND_NAME = "Neethi";

/** The arch alone. `working`: it draws itself, the colleague at work. */
export function BrandMark({ className, working }: { className?: string; working?: boolean }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={cn("size-6 shrink-0 text-primary", className)}>
      <path
        d="M24 78V46a24 24 0 0 1 48 0v32"
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
        className={working ? "arch-working" : undefined}
      />
    </svg>
  );
}

/** The mark and the lowercase wordmark. */
export function Brand({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark className={size === "lg" ? "size-7" : "size-[22px]"} />
      <span
        className={cn(
          "leading-none font-semibold tracking-[-0.03em] text-foreground",
          size === "lg" ? "text-[25px]" : "text-[19px]",
        )}
      >
        neethi
      </span>
      <span className="sr-only">{BRAND_NAME}</span>
    </span>
  );
}
