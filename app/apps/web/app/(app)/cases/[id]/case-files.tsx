"use client";
// A case's files, grouped by category (the service orders them: still processing first, then by kind of document).
// Uploads go through the global upload store, so they keep going when the user leaves the page; each file's state
// is followed live, and the list is fetched again when a file is added or finishes (it may move to its group).
import type { AppRouter } from "@sllaw/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Download, ExternalLink, FileText, MoreHorizontal, RotateCw, Trash2, Upload as UploadIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FileStateBadge, fileState } from "@/components/file-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { docTypeLabel, fmtDate, fmtSize } from "@/lib/format";
import { useFileStatus, useUploadStore } from "@/stores/upload-store";
import { trpcClient, useTRPC } from "@/trpc/client";

export type CaseFile = inferRouterOutputs<AppRouter>["case"]["files"][number];

const MAX_SIZE = 50 * 1024 * 1024; // the services' MAX_SIZE: a bigger file is refused there

export function CaseFiles({ caseId, initial }: { caseId: string; initial: CaseFile[] }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: files } = useQuery({ ...trpc.case.files.queryOptions({ caseId }), initialData: initial });
  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: trpc.case.files.queryKey({ caseId }) }),
    [qc, trpc, caseId],
  );
  const upload = useUploadStore((s) => s.upload);
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // an upload started here has a row once it has a file id: list again to show it
  const started = useUploadStore(
    useShallow((s) => Object.values(s.uploads).flatMap((u) => (u.caseId === caseId && u.fileId ? [u.fileId] : []))),
  );
  const unlisted = started.filter((id) => !files.some((f) => f.id === id)).join(",");
  useEffect(() => {
    if (unlisted) void refresh();
  }, [unlisted, refresh]);

  const add = (list: FileList | null) => {
    if (!list?.length) return;
    const tooBig: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_SIZE) tooBig.push(f.name);
      else if (f.size > 0) upload(f, { kind: "case", caseId });
    }
    setRefused(tooBig);
  };

  const groups = Map.groupBy(files, (f) => f.group);

  return (
    // the whole section takes dropped files
    <section
      aria-label="Case files: drop files here to add them"
      className="relative mt-10"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        add(e.dataTransfer.files);
      }}
    >
      <div className="flex items-end justify-between gap-4 border-b pb-3">
        <div>
          <h2 className="text-lg font-semibold">Files</h2>
          <p className="text-sm text-muted-foreground">
            {files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "Nothing added yet"}
          </p>
        </div>
        <Button size="sm" onClick={() => input.current?.click()}>
          <UploadIcon /> Add files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {refused.length > 0 && (
        <p className="mt-3 text-sm text-destructive">Over 50 MB, not added: {refused.join(", ")}</p>
      )}

      {files.length === 0 ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="mt-6 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center transition-colors hover:bg-accent/40"
        >
          <UploadIcon className="size-7 text-muted-foreground" />
          <span className="font-medium">Drop the case's files here, or click to choose</span>
          <span className="max-w-md text-sm text-muted-foreground">
            PDFs (scans too), Word documents and text, up to 50 MB each. Each file is read, sorted by kind and made
            searchable for this case.
          </span>
        </button>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          {[...groups].map(([group, items]) => (
            <div key={group}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal">{items.length}</span>
              </h3>
              <ul className="divide-y rounded-xl border bg-card">
                {items.map((f) => (
                  <FileItem key={f.id} caseId={caseId} f={f} onChange={refresh} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 -m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80">
          <p className="font-medium">Drop to add to this case</p>
        </div>
      )}
    </section>
  );
}

type Meta = { title?: string; court?: string | null; caseNumbers?: string[] };

function FileItem({ caseId, f, onChange }: { caseId: string; f: CaseFile; onChange: () => void }) {
  const u = useFileStatus(f.id, f.status);
  const state = fileState(u, f.status);
  const retry = useUploadStore((s) => s.retry);
  const dismiss = useUploadStore((s) => s.dismiss);
  const trpc = useTRPC();
  const remove = useMutation(trpc.case.removeFile.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // listed while processing and now done: list again, the file may move to its category's group
  const settled = u?.phase === "finished" || u?.phase === "failed";
  useEffect(() => {
    if (settled && !f.status.finished) onChange();
  }, [settled, f.status.finished, onChange]);

  const meta = (f.meta ?? {}) as Meta;
  const href = `/cases/${caseId}/files/${f.id}`;
  const details = [
    f.category && docTypeLabel(f.category),
    meta.caseNumbers?.[0],
    f.pages != null && `${f.pages} ${f.pages === 1 ? "page" : "pages"}`,
    fmtSize(f.size),
    fmtDate(f.createdAt),
  ].filter(Boolean);

  const download = async () => {
    setError(null);
    try {
      const v = await trpcClient.case.openFile.query({ caseId, fileId: f.id });
      if (v.downloadUrl) window.open(v.downloadUrl, "_blank", "noopener");
      else setError("The file has not finished uploading.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <FileText className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <Link href={href} className="block truncate text-sm font-medium hover:underline" title={f.name}>
          {meta.title || f.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {meta.title && <span title={f.name}>{f.name} · </span>}
          {details.join(" · ")}
        </p>
        {state.kind === "working" && state.label === "Uploading" && state.percent != null && (
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${state.percent}%` }} />
          </div>
        )}
        {(state.kind === "failed" || error) && (
          <p
            className="mt-0.5 line-clamp-2 text-xs text-destructive"
            title={error ?? (state.kind === "failed" ? state.message : undefined)}
          >
            {error ?? (state.kind === "failed" && state.message)}
          </p>
        )}
      </div>
      <FileStateBadge state={state} />
      {state.kind === "failed" && state.retryable && u && (
        <Button size="icon-sm" variant="ghost" title="Try again" onClick={() => void retry(u.key)}>
          <RotateCw />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="File actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={href}>
              <ExternalLink /> Details
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void download()} disabled={f.status.steps[0]?.state !== "stored"}>
            <Download /> Download
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDelete
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete "${f.name}"?`}
        description="The file is removed from this case, and the AI no longer finds it."
        onConfirm={async () => {
          await remove.mutateAsync({ caseId, fileId: f.id });
          if (u) dismiss(u.key);
          onChange();
        }}
      />
    </li>
  );
}
