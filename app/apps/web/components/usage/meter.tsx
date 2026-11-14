// One limit as a bar: what is used, and a line where the limit is. Under the limit the line is the end of the track;
// past it (a turn may end over) the track grows to the use and the line moves in, so the overrun shows.
import { fmtNum, fmtSize, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Unit = "count" | "bytes" | "usd" | "percent"; // percent: a lawyer's spend, as a share of the allowance

const GB = 1024 ** 3;
export const fmtUnit = (n: number, unit: Unit) =>
  unit === "usd"
    ? fmtUsd(n)
    : unit === "percent"
      ? `${Math.round(n)}%`
      : unit !== "bytes"
        ? fmtNum(n)
        : n >= GB
          ? `${Number((n / GB).toFixed(1))} GB`
          : fmtSize(n);

const resetLabel = (at: Date | null, per: string) =>
  !at
    ? null
    : per === "month"
      ? `Resets on ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" })}`
      : "Resets at midnight";

export function Meter({
  label,
  used,
  max,
  unit,
  per,
  resetsAt,
  big,
}: {
  label: string;
  used: number;
  max: number | null;
  unit: Unit;
  per: string;
  resetsAt: Date | null;
  big?: boolean;
}) {
  const scale = Math.max(used, max ?? 0, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const share = max ? used / max : 0;
  const reset = resetLabel(resetsAt, per);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("font-medium", big ? "text-base" : "text-sm")}>{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{fmtUnit(used, unit)}</span>
          {max == null ? " · no limit" : unit === "percent" ? " used" : ` of ${fmtUnit(max, unit)}`}
        </span>
      </div>
      {max != null && (
        <div
          className={cn("relative mt-2 rounded-full bg-muted", big ? "h-3" : "h-2")}
          aria-hidden // the numbers above say it in words
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-unverified-border" : "bg-primary",
            )}
            style={{ width: used ? `max(4px, ${pct(used)})` : 0 }}
          />
          {max != null && (
            <div
              className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded bg-foreground/70"
              style={{ left: pct(max) }}
              title={`Limit: ${fmtUnit(max, unit)}`}
            />
          )}
        </div>
      )}
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{max && unit !== "percent" ? `${Math.round(share * 100)}% used` : ""}</span>
        <span>{reset}</span>
      </div>
    </div>
  );
}
