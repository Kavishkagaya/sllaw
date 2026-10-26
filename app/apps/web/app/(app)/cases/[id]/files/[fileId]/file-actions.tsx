"use client";
// A file's live state with each step, and what can be done with it: download, try again, delete.
import type { FileStatus } from "@sllaw/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FileStateBadge, fileState } from "@/components/file-state";
import { Button } from "@/components/ui/button";
import { useFileStatus, useUploadStore } from "@/stores/upload-store";
import { useTRPC } from "@/trpc/client";

const STEP: Record<string, string> = { upload: "Upload", extract: "Read", categorize: "Categorize", index: "Index" };
const STATE: Record<string, string> = {
  pending: "waiting",
  running: "working",
  done: "done",
  stored: "done",
  failed: "failed",
  no_text: "no text",
};

export function FileActions({
  caseId,
  fileId,
  name,
  status,
  downloadUrl,
}: {
  caseId: string;
  fileId: string;
  name: string;
  status: FileStatus;
  downloadUrl: string | null;
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const u = useFileStatus(fileId, status);
  const state = fileState(u, status);
  const retry = useUploadStore((s) => s.retry);
  const dismiss = useUploadStore((s) => s.dismiss);
  const remove = useMutation(trpc.case.removeFile.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const steps = (u?.status ?? status).steps;

  // rendered while processing and now done: render again for the summary and the card
  const settled = u?.phase === "finished" || u?.phase === "failed";
  useEffect(() => {
    if (settled && !status.finished) router.refresh();
  }, [settled, status.finished, router]);

  return (
    <div className="mt-6 flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FileStateBadge state={state} />
        <span className="text-xs text-muted-foreground">
          {steps.map((s) => `${STEP[s.step] ?? s.step}: ${STATE[s.state] ?? s.state}`).join(" · ")}
        </span>
        <div className="ml-auto flex gap-2">
          {state.kind === "failed" && state.retryable && u && (
            <Button size="sm" variant="outline" onClick={() => void retry(u.key)}>
              <RotateCw /> Try again
            </Button>
          )}
          {downloadUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={downloadUrl} target="_blank" rel="noreferrer">
                <Download /> Download
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>
      {(state.kind === "failed" || state.kind === "no_text") && (
        <p className="text-sm text-muted-foreground">
          {state.message}
          {state.kind === "failed" && !state.retryable && " This file cannot be read as it is."}
        </p>
      )}
      <ConfirmDelete
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete "${name}"?`}
        description="The file is removed from this case, and the AI no longer finds it."
        onConfirm={async () => {
          await remove.mutateAsync({ caseId, fileId });
          if (u) dismiss(u.key);
          await qc.invalidateQueries({ queryKey: trpc.case.files.queryKey({ caseId }) });
          router.push(`/cases/${caseId}`);
          router.refresh();
        }}
      />
    </div>
  );
}
