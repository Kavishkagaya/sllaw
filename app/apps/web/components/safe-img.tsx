import { ownImage } from "@/lib/office";

/** Streamdown's `img`: our own images only; a remote one shows its alt text instead of being fetched. */
export function SafeImg({ src, alt }: { src?: unknown; alt?: string }) {
  if (!ownImage(src)) return <span className="text-muted-foreground">[image not shown{alt ? `: ${alt}` : ""}]</span>;
  // biome-ignore lint/performance/noImgElement: markdown content, size unknown
  return <img src={src as string} alt={alt ?? ""} className="max-w-full" />;
}
