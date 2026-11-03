"use client";
// Cost per day: one series, so no legend (the title names it). Columns <= 24px with a 2px gap, 4px rounded tops
// square at the baseline, hairline gridlines at clean ticks. Each column is its own hit target (the full height of
// its slot, not just the paint) with a tooltip on hover and focus; every value is also in the table under it.
import { useState } from "react";
import { fmtUsd } from "@/lib/format";

type Day = { day: string; costUsd: number; events: number };

const dayLabel = (d: string, long = false) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(
    "en-GB",
    long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" },
  );

/** Clean ticks from 0 to at least max: 1, 2 or 5 times a power of ten per step, 3-4 steps. */
function ticks(max: number) {
  if (max <= 0) return [0];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v < max + step / 2; v += step) out.push(Number(v.toPrecision(6)));
  if (out.at(-1)! < max) out.push(Number((out.at(-1)! + step).toPrecision(6)));
  return out;
}

export function DailyCostChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  // the tooltip sits over the column's centre, measured: columns stop growing at 24px, so they need not fill the row
  const show = (i: number, el: HTMLElement) => setHover({ i, x: el.offsetLeft + el.offsetWidth / 2 });
  const ys = ticks(Math.max(0, ...days.map((d) => d.costUsd)));
  const top = ys.at(-1) || 1;
  const h = (v: number) => `${(v / top) * 100}%`;
  const shown = hover && days[hover.i];
  const every = Math.max(1, Math.ceil(days.length / 6)); // x labels: about six, never crowded

  if (!days.length) return <p className="text-sm text-muted-foreground">No days in this period yet.</p>;
  return (
    <div>
      <div className="flex gap-2">
        {/* y axis */}
        <div className="relative h-48 w-12 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums">
          {ys.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2" style={{ bottom: h(v) }}>
              {fmtUsd(v)}
            </span>
          ))}
        </div>
        <div className="relative h-48 min-w-0 flex-1">
          {ys.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-border" style={{ bottom: h(v) }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
            {days.map((d, i) => (
              <button
                key={d.day}
                type="button"
                aria-label={`${dayLabel(d.day, true)}: ${fmtUsd(d.costUsd)}, ${d.events} calls`}
                onPointerEnter={(e) => show(i, e.currentTarget)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => setHover(null)}
                className="group flex h-full min-w-0 max-w-6 flex-1 cursor-default items-end justify-center outline-none"
              >
                <span
                  className="w-full rounded-t-[4px] bg-primary transition-opacity group-hover:opacity-80 group-focus-visible:ring-2 group-focus-visible:ring-ring"
                  style={{ height: d.costUsd ? `max(2px, ${h(d.costUsd)})` : 0 }}
                />
              </button>
            ))}
          </div>
          {shown && hover && (
            <div
              role="status"
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-sm"
              style={{ left: hover.x }}
            >
              <div className="text-sm font-semibold tabular-nums">{fmtUsd(shown.costUsd)}</div>
              <div className="text-muted-foreground">
                {dayLabel(shown.day, true)} · {shown.events} calls
              </div>
            </div>
          )}
        </div>
      </div>
      {/* x axis */}
      <div className="ml-14 flex gap-[2px] text-[0.7rem] text-muted-foreground">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 max-w-6 flex-1 overflow-visible whitespace-nowrap">
            {i % every === 0 ? dayLabel(d.day) : ""}
          </span>
        ))}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show as a table</summary>
        <table className="mt-2 w-full max-w-sm text-sm [&_td]:py-1">
          <tbody>
            {days.map((d) => (
              <tr key={d.day} className="border-b last:border-0">
                <td>{dayLabel(d.day, true)}</td>
                <td className="text-right tabular-nums">{fmtUsd(d.costUsd)}</td>
                <td className="text-right text-muted-foreground tabular-nums">{d.events} calls</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
