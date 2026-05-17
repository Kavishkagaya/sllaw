"use client";

import { useState } from "react";
import JsonTree from "./JsonTree";

interface DocViewerProps {
  data: unknown;
  pdfUrl: string | null;
}

type Panel = "split" | "pdf" | "json";

export default function DocViewer({ data, pdfUrl }: DocViewerProps) {
  const [panel, setPanel] = useState<Panel>(pdfUrl ? "split" : "json");

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 bg-gray-50 border-b border-gray-200">
        {(["split", "pdf", "json"] as Panel[]).map((p) => (
          <button
            key={p}
            onClick={() => setPanel(p)}
            disabled={p !== "json" && !pdfUrl}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              panel === p
                ? "bg-blue-600 text-white"
                : "text-gray-500 hover:text-gray-900 hover:bg-gray-200"
            }`}
          >
            {p === "split" ? "Split" : p === "pdf" ? "PDF" : "JSON"}
          </button>
        ))}
      </div>

      {/* Panels */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {(panel === "split" || panel === "pdf") && (
          <div className={`${panel === "split" ? "w-1/2 border-r border-gray-200" : "w-full"} flex flex-col`}>
            {pdfUrl ? (
              <iframe src={pdfUrl} className="w-full h-full" title="PDF" />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                No PDF available
              </div>
            )}
          </div>
        )}

        {(panel === "split" || panel === "json") && (
          <div className={`${panel === "split" ? "w-1/2" : "w-full"} overflow-auto bg-white`}>
            <div className="p-5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
                Document JSON
              </p>
              <JsonTree data={data} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
