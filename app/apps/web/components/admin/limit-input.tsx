"use client";
// A limit's max as typed on /admin: storage in MB, spend in USD (cents and below), counts whole; empty = no limit.
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

const MB = 1024 * 1024;
export const toInput = (unit: string, v: number | null | undefined) =>
  v == null ? "" : String(unit === "bytes" ? Math.round(v / MB) : v);
export const fromInput = (unit: string, s: string): number | null | undefined => {
  const t = s.trim().replaceAll(",", "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined; // not a number: not saved
  return unit === "usd" ? n : Math.round(unit === "bytes" ? n * MB : n);
};
export const unitHint = (unit: string) => (unit === "bytes" ? "MB" : unit === "usd" ? "USD" : "");

/** Saves on blur or Enter when the value changed; shows the unit beside it. */
export function LimitInput({
  unit,
  value,
  onSave,
  disabled,
}: {
  unit: string;
  value: number | null;
  onSave: (v: number | null) => void;
  disabled?: boolean;
}) {
  const [s, setS] = useState(toInput(unit, value));
  const saved = useRef(value); // the last value sent, so Enter then blur saves once
  useEffect(() => {
    setS(toInput(unit, value));
    saved.current = value;
  }, [unit, value]);
  const commit = () => {
    const v = fromInput(unit, s);
    if (v === undefined) return setS(toInput(unit, value));
    if (v !== saved.current) {
      saved.current = v;
      onSave(v);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        inputMode={unit === "usd" ? "decimal" : "numeric"}
        className="h-8 w-32 text-right tabular-nums"
        placeholder="No limit"
        value={s}
        disabled={disabled}
        onChange={(e) => setS(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span className="w-12 text-xs text-muted-foreground">{unitHint(unit)}</span>
    </div>
  );
}
