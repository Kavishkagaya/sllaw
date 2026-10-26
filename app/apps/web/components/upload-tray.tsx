"use client";
// Every upload in the app, bottom right, wherever the user is: bytes sent, then each step's state as the server
// reports it (stores/upload-store.ts). Nothing shows when there is nothing to show.
import { CheckCircle2, Loader2, RotateCw, X, XCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Upload, useUploadStore } from "@/stores/upload-store";

const LABEL: Record<string, string> = { upload: "Upload", extract: "Read", categorize: "Categorize", index: "Index" };
const STATE: Record<string, string> = {
  pending: "waiting",
  running: "working",
  done: "done",
  stored: "done",
  failed: "failed",
  no_text: "no text",
};

export function UploadTray() {
  // a case's page lists its own files with their states: the tray leaves those out there
  const onCase = usePathname().match(/^\/cases\/([0-9a-f-]{36})/)?.[1];
  const uploads = Object.values(useUploadStore((s) => s.uploads)).filter(
    (u) => u.name && (!onCase || u.caseId !== onCase),
  );
  if (!uploads.length) return null;
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {uploads.map((u) => (
        <UploadCard key={u.key} u={u} />
      ))}
    </div>
  );
}

function UploadCard({ u }: { u: Upload }) {
  const retry = useUploadStore((s) => s.retry);
  const dismiss = useUploadStore((s) => s.dismiss);
  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground shadow-md">
      <div className="flex items-center gap-2">
        <PhaseIcon phase={u.phase} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={u.name}>
          {u.name}
        </span>
        {u.retryable && u.fileId && (u.phase === "failed" || u.phase === "finished") && (
          <Button size="icon" variant="ghost" className="size-6" title="Try again" onClick={() => void retry(u.key)}>
            <RotateCw />
          </Button>
        )}
        {(u.phase === "finished" || u.phase === "failed") && (
          <Button size="icon" variant="ghost" className="size-6" title="Dismiss" onClick={() => dismiss(u.key)}>
            <X />
          </Button>
        )}
      </div>
      {u.phase === "uploading" && u.size > 0 && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.round((u.sent / u.size) * 100)}%` }}
          />
        </div>
      )}
      {u.status && (
        <div className="mt-2 flex flex-wrap gap-1">
          {u.status.steps.map((s) => (
            <Badge
              key={s.step}
              variant={
                s.state === "failed"
                  ? "destructive"
                  : s.state === "done" || s.state === "stored"
                    ? "secondary"
                    : "outline"
              }
              title={s.error?.message}
            >
              {LABEL[s.step] ?? s.step}: {STATE[s.state] ?? s.state}
            </Badge>
          ))}
        </div>
      )}
      {u.error && <p className="mt-2 text-xs text-destructive">{u.error}</p>}
      {u.status?.steps
        .filter((s) => s.state === "failed" && s.error)
        .map((s) => (
          <p key={s.step} className="mt-1 text-xs text-muted-foreground">
            {s.error!.message}
            {!s.error!.retryable && " This file cannot be read as it is."}
          </p>
        ))}
    </div>
  );
}

function PhaseIcon({ phase }: { phase: Upload["phase"] }) {
  if (phase === "finished") return <CheckCircle2 className="size-4 text-primary" />;
  if (phase === "failed") return <XCircle className="size-4 text-destructive" />;
  return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
}
