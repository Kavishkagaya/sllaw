import { cn } from "@/lib/utils";

// Hulft, after Hulftsdorp, the courts' district in Aluthkade, Colombo. The mark is a gabled H: its two stems are a
// courthouse's columns, cut so their tops make the roof and the gap between them its door, and the crossbar is a balance
// beam on a pivot, the scales of justice held between the columns. In oxblood (the theme's primary, so it lightens in
// dark). app/icon.svg is the same H, white on an oxblood tile.
export const BRAND_NAME = "Hulft";

/** The mark's shapes (columns, beam, pivot), for an <svg viewBox="0 0 96 96">: filled in the mark, outlined in the drawings. */
export function MarkParts() {
  return (
    <>
      <path d="M16 31 38 21.1V75H16Z" />
      <path d="M58 21.1 80 31V75H58Z" />
      <path d="M38 48H58V52H38Z" />
      <path d="M48 40 53 48H43Z" />
    </>
  );
}

/** The mark alone. `working`: the beam weighs, rocking on its pivot: the colleague at work. */
export function BrandMark({ className, working }: { className?: string; working?: boolean }) {
  return (
    <svg
      viewBox="0 0 96 96"
      aria-hidden
      className={cn("size-6 shrink-0 fill-current text-primary", working && "mark-working", className)}
    >
      <MarkParts />
    </svg>
  );
}

/** The mark and the wordmark. */
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
        {BRAND_NAME}
      </span>
    </span>
  );
}
