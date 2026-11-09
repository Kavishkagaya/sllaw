// One limit as a bar: what is used, and a line where the limit is. Under the limit the line is the end of the track;
// past it (a turn may end over) the track grows to the use and the line moves in, so the overrun shows.
import { fmtNum, fmtSize } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Unit = "count" | "tokens" | "bytes";

export const fmtUnit = (n: number, unit: Unit) => (unit === "bytes" ? fmtSize(n) : fmtNum(n));

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
  const scale = max == null ? Math.max(used, 1) : Math.max(used, max, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const share = max ? used / max : 0;
  const reset = resetLabel(resetsAt, per);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("font-medium", big ? "text-base" : "text-sm")}>{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{fmtUnit(used, unit)}</span>
          {max == null ? " · no limit" : ` of ${fmtUnit(max, unit)}`}
        </span>
      </div>
      <div
        className={cn("relative mt-2 rounded-full bg-muted", big ? "h-3" : "h-2")}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={used}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-brass" : "bg-primary",
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
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{max ? `${Math.round(share * 100)}% used` : ""}</span>
        <span>{reset}</span>
      </div>
    </div>
  );
}
