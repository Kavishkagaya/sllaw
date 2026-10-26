"use client";
// Uploads live here, not in a page, so a file keeps uploading and its processing stays followed while the user moves
// around the app. One entry per file: start (the service that adds it: a case, or the user's own files) -> the bytes
// to the store with progress -> finish -> its states as server-sent events (/api/files/<id>/events) until it is
// finished. A page shows an entry with useFileStatus(fileId); the tray (components/upload-tray.tsx) shows them all.
import type { FileEvent, FileStatus, StepStatus } from "@sllaw/api";
import { useEffect } from "react";
import { create } from "zustand";
import { trpcClient } from "@/trpc/client";

export type Target = { kind: "case"; caseId: string } | { kind: "private" };
export type Phase = "starting" | "uploading" | "processing" | "finished" | "failed";

export type Upload = {
  key: string; // the file id once there is one; a local id before
  fileId: string | null;
  caseId: string | null; // the case it was added to (a page lists the case's files again once it has an id)
  name: string;
  size: number;
  sent: number; // bytes sent so far
  phase: Phase;
  error: string | null; // the upload's own (it could not start, send or follow); a step's is in status
  retryable: boolean; // whether "Try again" can help: a step failed with a retryable error, or the run stopped
  status: FileStatus | null; // the server's: every step with its state
};

type State = {
  uploads: Record<string, Upload>;
  /** Uploads a file to a case or to the user's own files and follows it. Returns its key. */
  upload: (file: File, target: Target) => string;
  /** Follows a file uploaded earlier (a page listing it): its states until it is finished. */
  track: (fileId: string, name?: string, initial?: FileStatus) => void;
  /** Runs a file's failed steps again and follows the new run. */
  retry: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
};

// open EventSources, by key: not state (nothing renders them)
const sources = new Map<string, EventSource>();
const REOPEN = 3; // a stream that ends while steps are still open (a newer run took over) is opened again, this many times

export const useUploadStore = create<State>()((set, get) => {
  const patch = (key: string, p: Partial<Upload> | ((u: Upload) => Partial<Upload>)) =>
    set((s) => {
      const u = s.uploads[key];
      if (!u) return s;
      return { uploads: { ...s.uploads, [key]: { ...u, ...(typeof p === "function" ? p(u) : p) } } };
    });

  const retryableIn = (status: FileStatus) => status.steps.some((s) => s.state === "failed" && !!s.error?.retryable);
  const settle = (key: string, status: FileStatus) =>
    patch(key, {
      status,
      retryable: status.finished && retryableIn(status),
      phase: status.finished ? (status.steps[0]?.state === "failed" ? "failed" : "finished") : "processing",
    });

  /** An event changes its step unless the snapshot the entry has is newer (a stream replayed from its start). */
  const apply = (key: string, e: FileEvent) =>
    patch(key, (u) => {
      if (!u.status || e.at < u.status.at) return {};
      const steps: StepStatus[] = u.status.steps.some((s) => s.step === e.step)
        ? u.status.steps.map((s) => (s.step === e.step ? { step: e.step, state: e.state, error: e.error } : s))
        : [...u.status.steps, { step: e.step, state: e.state, error: e.error }];
      return { status: { ...u.status, steps } };
    });

  const follow = (key: string, reopens = REOPEN) => {
    const fileId = get().uploads[key]?.fileId;
    if (!fileId || typeof window === "undefined") return;
    sources.get(key)?.close();
    const es = new EventSource(`/api/files/${fileId}/events`);
    sources.set(key, es);
    es.addEventListener("snapshot", (m) => settle(key, JSON.parse(m.data) as FileStatus));
    es.addEventListener("state", (m) => apply(key, JSON.parse(m.data) as FileEvent));
    es.addEventListener("end", () => {
      es.close();
      sources.delete(key);
      const status = get().uploads[key]?.status;
      const open = status?.steps.some((s) => s.state === "pending" || s.state === "running");
      if (open && reopens > 0) setTimeout(() => follow(key, reopens - 1), 2000);
      // the run is over and a step never finished: say so, and offer a retry, rather than spin forever
      else if (open)
        patch(key, { phase: "failed", retryable: true, error: "Processing stopped before it finished. Try again." });
      else if (status) settle(key, { ...status, finished: true });
    });
    // a dropped connection reconnects by itself (with Last-Event-ID); a refused one (404, 401) is closed
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        sources.delete(key);
        patch(key, { phase: "failed", error: "lost the file's status" });
      }
    };
  };

  const send = (key: string, url: string, file: File, headers: Record<string, string>) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => patch(key, { sent: e.loaded });
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error("upload failed (network)"));
      xhr.send(file);
    });

  return {
    uploads: {},

    upload: (file, target) => {
      const local = crypto.randomUUID();
      set((s) => ({
        uploads: {
          ...s.uploads,
          [local]: {
            key: local,
            fileId: null,
            caseId: target.kind === "case" ? target.caseId : null,
            name: file.name,
            size: file.size,
            sent: 0,
            phase: "starting",
            error: null,
            retryable: false,
            status: null,
          },
        },
      }));
      void (async () => {
        try {
          const input = { name: file.name, mime: file.type, size: file.size };
          const up =
            target.kind === "case"
              ? await trpcClient.case.addFile.mutate({ caseId: target.caseId, ...input })
              : await trpcClient.file.startUpload.mutate(input);
          patch(local, { fileId: up.fileId, phase: "uploading" });
          // no direct upload (STORAGE=memory): through the app
          await send(local, up.uploadUrl ?? `/api/files/${up.fileId}`, file, up.headers);
          patch(local, { sent: file.size });
          settle(local, await trpcClient.file.finishUpload.mutate({ fileId: up.fileId }));
          follow(local);
        } catch (e) {
          patch(local, { phase: "failed", error: (e as Error).message });
        }
      })();
      return local;
    },

    track: (fileId, name = "", initial) => {
      if (get().uploads[fileId] || Object.values(get().uploads).some((u) => u.fileId === fileId)) return;
      set((s) => ({
        uploads: {
          ...s.uploads,
          [fileId]: {
            key: fileId,
            fileId,
            caseId: null,
            name,
            size: 0,
            sent: 0,
            phase: "processing",
            error: null,
            retryable: false,
            status: initial ?? null,
          },
        },
      }));
      if (initial?.finished) settle(fileId, initial);
      else follow(fileId);
    },

    retry: async (key) => {
      const fileId = get().uploads[key]?.fileId;
      if (!fileId) return;
      patch(key, { phase: "processing", error: null, retryable: false });
      try {
        await trpcClient.file.reprocess.mutate({ fileId });
        follow(key);
      } catch (e) {
        patch(key, { phase: "failed", error: (e as Error).message });
      }
    },

    dismiss: (key) => {
      sources.get(key)?.close();
      sources.delete(key);
      set((s) => {
        const { [key]: _, ...rest } = s.uploads;
        return { uploads: rest };
      });
    },
  };
});

/** A file's live status on a page. Pass the status the server rendered: it shows at once, and the file is followed
 *  from there if it is not finished. */
export function useFileStatus(fileId: string, initial?: FileStatus, name?: string): Upload | null {
  const u = useUploadStore(
    (s) => s.uploads[fileId] ?? Object.values(s.uploads).find((x) => x.fileId === fileId) ?? null,
  );
  const track = useUploadStore((s) => s.track);
  // in an effect, not during render: it opens a connection. Only when the file changes: a new `initial` for the
  // same file is the same status rendered again
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the file changes (see above)
  useEffect(() => track(fileId, name, initial), [fileId, track]);
  if (u) return u;
  if (!initial) return null;
  const retryable = initial.finished && initial.steps.some((s) => s.state === "failed" && !!s.error?.retryable);
  return {
    key: fileId,
    fileId,
    caseId: null,
    name: name ?? "",
    size: 0,
    sent: 0,
    phase: initial.finished ? "finished" : "processing",
    error: null,
    retryable,
    status: initial,
  };
}
