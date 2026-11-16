import { ScanText } from "lucide-react";
import { cn } from "@/lib/utils";

/** On a file whose text was read from a scan or photo (OCR): a misread name, date or amount looks like a real one. */
export function ScanNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
      <ScanText className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>Read from a scan. Check names, dates and amounts against the original.</span>
    </p>
  );
}
