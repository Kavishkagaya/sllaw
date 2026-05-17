"use client";

import { useState } from "react";

function JsonNode({ data, depth }: { data: unknown; depth: number }) {
  const isArray = Array.isArray(data);
  const isObj =
    !isArray && typeof data === "object" && data !== null;
  const count = isArray
    ? (data as unknown[]).length
    : isObj
    ? Object.keys(data as object).length
    : 0;
  const defaultOpen = depth < 2 && count <= 15;
  const [open, setOpen] = useState(defaultOpen);

  if (data === null) return <span className="text-gray-400">null</span>;
  if (typeof data === "boolean")
    return <span className="text-yellow-600">{String(data)}</span>;
  if (typeof data === "number")
    return <span className="text-blue-500">{data}</span>;
  if (typeof data === "string") {
    const display = data.length > 140 ? data.slice(0, 140) + "…" : data;
    return <span className="text-green-700 break-all">&quot;{display}&quot;</span>;
  }

  if (isArray) {
    if (count === 0) return <span className="text-gray-400">[]</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-gray-500 hover:text-gray-900 select-none cursor-pointer"
        >
          {open ? "▾" : "▸"}{" "}
          <span className="text-gray-400 text-xs">[{count}]</span>
        </button>
        {open && (
          <ul className="ml-4 border-l border-gray-200 pl-3 mt-0.5 space-y-0.5">
            {(data as unknown[]).map((item, i) => (
              <li key={i} className="flex gap-1.5 items-start">
                <span className="text-gray-400 shrink-0 text-xs pt-0.5">{i}</span>
                <JsonNode data={item} depth={depth + 1} />
              </li>
            ))}
          </ul>
        )}
      </span>
    );
  }

  if (isObj) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-gray-400">{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-gray-500 hover:text-gray-900 select-none cursor-pointer"
        >
          {open ? "▾" : "▸"}{" "}
          <span className="text-gray-400 text-xs">
            {"{"}{count}{"}"}
          </span>
        </button>
        {open && (
          <ul className="ml-4 border-l border-gray-200 pl-3 mt-0.5 space-y-0.5">
            {entries.map(([key, value]) => (
              <li key={key} className="flex gap-1.5 items-start flex-wrap">
                <span className="text-purple-600 shrink-0 font-medium">{key}:</span>
                <JsonNode data={value} depth={depth + 1} />
              </li>
            ))}
          </ul>
        )}
      </span>
    );
  }

  return <span>{String(data)}</span>;
}

export default function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="font-mono text-sm leading-6">
      <JsonNode data={data} depth={0} />
    </div>
  );
}
