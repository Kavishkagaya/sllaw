import { cn } from "@/lib/utils";

// One colour: the ink of the theme, so the mark is ink on paper in light and paper on ink in dark. app/icon.svg is
// the same mark for the browser tab. The name is a placeholder until it is chosen.
export const BRAND_NAME = "sllaw";

/** The mark alone: a serif § on an ink tile. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg font-serif text-[1.35rem] leading-none font-semibold text-background bg-foreground",
        className,
      )}
    >
      <span className="-mt-0.5">§</span>
    </span>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="flex flex-col gap-0.5 leading-none">
        <span className="font-serif text-lg font-semibold tracking-tight">{BRAND_NAME}</span>
        <span className="text-[11px] tracking-wide text-muted-foreground">Sri Lankan law</span>
      </span>
    </span>
  );
}
