"use client";
// Context per day this month, with the daily limit as a dashed line: the user sees which days came near it. One
// series, columns <= 24px, a tooltip per column on hover and focus, every value also in the table under it (as the
// admin cost chart).
import { useState } from "react";
import { ticks } from "@/components/admin/daily-cost-chart";
import { fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

type Day = { day: string; tokens: number; messages: number };

const dayLabel = (d: string, long = false) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(
    "en-GB",
    long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" },
  );

export function ContextChart({ days, limit }: { days: Day[]; limit: number | null }) {
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const show = (i: number, el: HTMLElement) => setHover({ i, x: el.offsetLeft + el.offsetWidth / 2 });
  const ys = ticks(Math.max(0, limit ?? 0, ...days.map((d) => d.tokens)));
  const top = ys.at(-1) || 1;
  const h = (v: number) => `${(v / top) * 100}%`;
  const shown = hover && days[hover.i];
  const every = Math.max(1, Math.ceil(days.length / 6));

  if (!days.length) return <p className="text-sm text-muted-foreground">No usage this month yet.</p>;
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative h-48 w-12 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums">
          {ys.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2" style={{ bottom: h(v) }}>
              {fmtNum(v)}
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
                aria-label={`${dayLabel(d.day, true)}: ${fmtNum(d.tokens)} tokens, ${d.messages} messages`}
                onPointerEnter={(e) => show(i, e.currentTarget)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => setHover(null)}
                className="group flex h-full min-w-0 max-w-6 flex-1 cursor-default items-end justify-center outline-none"
              >
                <span
                  className={cn(
                    "w-full rounded-t-[4px] transition-opacity group-hover:opacity-80 group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    limit && d.tokens >= limit ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ height: d.tokens ? `max(2px, ${h(d.tokens)})` : 0 }}
                />
              </button>
            ))}
          </div>
          {limit != null && (
            <div className="pointer-events-none absolute inset-x-0" style={{ bottom: h(limit) }}>
              <div className="border-t-2 border-dashed border-foreground/60" />
              <span className="absolute right-0 bottom-1 rounded bg-background/90 px-1 text-[0.7rem] font-medium text-foreground">
                Daily limit {fmtNum(limit)}
              </span>
            </div>
          )}
          {shown && hover && (
            <div
              role="status"
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-sm"
              style={{ left: hover.x }}
            >
              <div className="text-sm font-semibold tabular-nums">{fmtNum(shown.tokens)} tokens</div>
              <div className="text-muted-foreground">
                {dayLabel(shown.day, true)} · {shown.messages} messages
              </div>
            </div>
          )}
        </div>
      </div>
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
                <td className="text-right tabular-nums">{fmtNum(d.tokens)} tokens</td>
                <td className="text-right text-muted-foreground tabular-nums">{d.messages} messages</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
