"use client";
// One line for where a file is: uploading (with progress), reading, categorizing, indexing, ready, or what failed.
import type { FileStatus } from "@sllaw/api";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Upload } from "@/stores/upload-store";

const DOING: Record<string, string> = {
  upload: "Uploading",
  extract: "Reading",
  categorize: "Categorizing",
  index: "Indexing",
};

export type FileState =
  | { kind: "working"; label: string; percent?: number }
  | { kind: "ready" }
  | { kind: "no_text"; message: string }
  | { kind: "failed"; message: string; retryable: boolean };

/** The state to show, from the live entry when there is one, else from the status the server rendered. */
export function fileState(u: Upload | null, status: FileStatus): FileState {
  if (u?.phase === "starting") return { kind: "working", label: "Starting" };
  if (u?.phase === "uploading") {
    const percent = u.size ? Math.round((u.sent / u.size) * 100) : undefined;
    // every byte sent: the server is checking the file and starting its processing
    if (percent === 100) return { kind: "working", label: "Finishing upload" };
    return { kind: "working", label: "Uploading", percent };
  }
  if (u?.error && u.phase === "failed") return { kind: "failed", message: u.error, retryable: u.retryable };
  const s = u?.status ?? status;
  const failed = s.steps.find((x) => x.state === "failed");
  if (failed)
    return {
      kind: "failed",
      message: failed.error?.message ?? `${DOING[failed.step] ?? failed.step} failed`,
      retryable: !!failed.error?.retryable,
    };
  const open = s.steps.find((x) => x.state === "running") ?? s.steps.find((x) => x.state === "pending");
  if (open && !s.finished) return { kind: "working", label: DOING[open.step] ?? open.step };
  if (s.steps.some((x) => x.state === "no_text"))
    return { kind: "no_text", message: "No text found: the file is kept, but the AI cannot read it." };
  return { kind: "ready" };
}

export function FileStateBadge({ state }: { state: FileState }) {
  switch (state.kind) {
    case "working":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Loader2 className="animate-spin" />
          {state.label}
          {state.percent != null && ` ${state.percent}%`}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1" title={state.message}>
          <XCircle /> Failed
        </Badge>
      );
    case "no_text":
      return (
        <Badge variant="outline" className="gap-1" title={state.message}>
          <AlertTriangle /> No text
        </Badge>
      );
    case "ready":
      return (
        <Badge variant="secondary" className="gap-1">
          <CheckCircle2 /> Ready
        </Badge>
      );
  }
}
