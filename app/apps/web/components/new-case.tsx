"use client";
// New case (docs/features/onboarding.json), also a new lawyer's first screen: tell us about the case (any language)
// and drop its files; each file is read live, and what it holds shows as it comes; once every file is read the draft
// fills a card the lawyer checks and edits; "Looks right" makes the case with its files, fills its page, and opens
// its chat with a first brief streaming.
import type { AppRouter } from "@sllaw/api";
import { ROLES, SIDES, STAGES } from "@sllaw/office";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, FileText, Loader2, Paperclip, Plus, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { docTypeLabel } from "@/lib/format";
import { label } from "@/lib/office";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { type Upload, useUploadStore } from "@/stores/upload-store";
import { trpcClient, useTRPC } from "@/trpc/client";

type Card = inferRouterOutputs<AppRouter>["case"]["draft"];
type Found = {
  court?: string | null;
  caseNumbers?: string[];
  parties?: { name: string; role: string }[];
  dates?: { date: string; what: string }[];
};

const MAX_SIZE = 50 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.txt,.html,image/*";
const PARTY_ROLES = ROLES.filter((r) => r !== "client" && r !== "judge");
// what the lawyer sends to start the case's chat: the first brief
const FIRST_BRIEF =
  "Brief me on this case: the issues, the sections that apply as amended today, and the facts still missing.";

const EMPTY: Card = {
  title: "",
  court: "",
  caseNumber: "",
  kind: "",
  side: "",
  stage: "",
  client: "",
  parties: [],
  nextDate: null,
  missing: [],
};

const stateOf = (u: Upload | undefined, step: string) => u?.status?.steps.find((s) => s.step === step)?.state;
const isDone = (u: Upload | undefined) => !u || u.phase === "finished" || u.phase === "failed";

export function NewCase() {
  const trpc = useTRPC();
  const router = useRouter();
  const upload = useUploadStore((s) => s.upload);
  const dismiss = useUploadStore((s) => s.dismiss);
  const uploads = useUploadStore((s) => s.uploads);
  const sendChat = useChatStore((s) => s.send);
  const [text, setText] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [found, setFound] = useState<Record<string, Found>>({});
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [waiting, setWaiting] = useState(false); // "Continue" pressed while files are still being read
  const [card, setCard] = useState<Card | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const draft = useMutation(trpc.case.draft.mutationOptions());
  const start = useMutation(trpc.case.start.mutationOptions());

  const fileIds = keys.map((k) => uploads[k]?.fileId).filter((id): id is string => !!id);
  const reading = keys.some((k) => !isDone(uploads[k]));

  const add = (list: FileList | null) => {
    if (!list) return;
    const tooBig: string[] = [];
    const added: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_SIZE) tooBig.push(f.name);
      else if (f.size > 0) added.push(upload(f, { kind: "draft" }));
    }
    setRefused(tooBig);
    setKeys((k) => [...k, ...added]);
  };

  const remove = (key: string) => {
    const id = uploads[key]?.fileId;
    setKeys((k) => k.filter((x) => x !== key));
    setFound(({ [key]: _, ...rest }) => rest);
    dismiss(key);
    if (id) void trpcClient.file.delete.mutate({ fileId: id }).catch(() => {}); // still being read: it stays, unused
  };

  const makeDraft = async () => {
    setWaiting(false);
    try {
      setCard(await draft.mutateAsync({ text, fileIds }));
    } catch {
      setCard(EMPTY); // the lawyer can still fill it in; the error shows above the card
    }
  };

  // the draft waits for every file to be read
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once when the last file is read
  useEffect(() => {
    if (waiting && !reading) void makeDraft();
  }, [waiting, reading]);

  const confirm = async () => {
    if (!card) return;
    const { id } = await start.mutateAsync({
      text,
      fileIds,
      card: { ...card, title: card.title.trim() || "New case" },
    });
    for (const k of keys) dismiss(k); // they are the case's files now: its Files page follows them
    const chatId = crypto.randomUUID();
    sendChat(chatId, FIRST_BRIEF, id);
    router.push(`/cases/${id}/chats/${chatId}`);
  };

  const canGo = !!text.trim() || keys.length > 0;
  const facts = merge(Object.values(found));

  if (card)
    return (
      <CheckCard
        card={card}
        setCard={setCard}
        error={draft.error?.message ?? null}
        saveError={start.error?.message ?? null}
        saving={start.isPending}
        files={keys.length}
        onBack={() => setCard(null)}
        onConfirm={() => void confirm().catch(() => {})}
      />
    );

  return (
    <div className="flex flex-col gap-5">
      <section
        aria-label="Tell us about the case: drop files here"
        className={cn(
          "rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring/50",
          dragging && "border-primary bg-accent/40",
        )}
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
        <label htmlFor="about" className="sr-only">
          Tell us about the case
        </label>
        <Textarea
          id="about"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            "Tell us about the case, in Sinhala, Tamil or English: who you act for, the court and number, what happened, the next date.\nOr drop the plaint, the journal, photos of a scan."
          }
          className="min-h-40 resize-y border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
          maxLength={20_000}
          autoFocus
        />
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => picker.current?.click()}>
            <Paperclip /> Add files
          </Button>
          <span className="text-xs text-muted-foreground">PDF, Word, photos · drop them here</span>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      {refused.length > 0 && <p className="text-sm text-destructive">Over 50 MB, not added: {refused.join(", ")}</p>}

      {keys.length > 0 && (
        <ul className="flex flex-col gap-2">
          {keys.map((k) => (
            <FileLine
              key={k}
              u={uploads[k]}
              onFound={(f) => setFound((x) => ({ ...x, [k]: f }))}
              onRemove={() => remove(k)}
            />
          ))}
        </ul>
      )}

      {facts && (
        <div className="rounded-lg border border-dashed px-4 py-3 text-sm">
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Found so far</p>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={() => setWaiting(true)} disabled={!canGo || waiting || draft.isPending} className="min-w-32">
          {(waiting || draft.isPending) && <Loader2 className="animate-spin" />}
          {draft.isPending ? "Drafting the case…" : waiting ? "Reading the files…" : "Continue"}
        </Button>
        {!canGo && <span className="text-xs text-muted-foreground">Write a few lines or add a file.</span>}
      </div>
    </div>
  );
}

/** What the files hold so far, merged: court, case numbers, parties, dates. null before anything is found. */
function merge(list: Found[]): [string, string][] | null {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const courts = uniq(list.map((f) => f.court ?? ""));
  const numbers = uniq(list.flatMap((f) => f.caseNumbers ?? []));
  const parties = uniq(list.flatMap((f) => (f.parties ?? []).map((p) => `${p.name} (${p.role})`)));
  const dates = uniq(list.flatMap((f) => (f.dates ?? []).map((d) => `${d.date}: ${d.what}`)));
  const rows: [string, string][] = [];
  if (courts.length) rows.push(["Court", courts.join("; ")]);
  if (numbers.length) rows.push(["Case number", numbers.join("; ")]);
  if (parties.length) rows.push(["Parties", parties.slice(0, 8).join(", ")]);
  if (dates.length) rows.push(["Dates", dates.slice(0, 5).join("; ")]);
  return rows.length ? rows : null;
}

/** One dropped file: what is happening to it, then what it is. */
function FileLine({ u, onFound, onRemove }: { u?: Upload; onFound: (f: Found) => void; onRemove: () => void }) {
  const trpc = useTRPC();
  const extracted = stateOf(u, "extract");
  const categorized = stateOf(u, "categorize");
  const file = useQuery({
    ...trpc.file.open.queryOptions({ fileId: u?.fileId ?? "" }),
    enabled: !!u?.fileId && extracted === "done",
  });
  const { refetch } = file;
  useEffect(() => {
    if (categorized === "done") void refetch();
  }, [categorized, refetch]);
  const row = file.data?.file;
  const meta = (categorized === "done" && row?.meta ? row.meta : null) as (Found & { title?: string }) | null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: report each new card once
  useEffect(() => {
    if (meta) onFound(meta);
  }, [meta]);
  if (!u) return null;

  const failed = u.phase === "failed" || extracted === "failed" || extracted === "no_text" || categorized === "failed";
  const pages = row?.pages ? `${row.pages} ${row.pages === 1 ? "page" : "pages"}` : "";
  let line: string;
  if (failed)
    line =
      extracted === "no_text"
        ? "No text could be read from it"
        : (u.error ?? u.status?.steps.find((s) => s.error)?.error?.message ?? "Could not be read");
  else if (u.phase === "starting" || u.phase === "uploading")
    line = `Uploading ${u.size ? Math.round((u.sent / u.size) * 100) : 0}%`;
  else if (extracted !== "done") line = "Reading…";
  else if (!meta) line = `Read ${pages || "it"} · working out what it is…`;
  else {
    const type = row?.category ? docTypeLabel(row.category) : "";
    const title = meta.title ?? "";
    line = type && !title.toLowerCase().startsWith(type.toLowerCase()) ? `${type}: ${title}` : title || type;
  }
  const busy = !failed && !meta;

  return (
    <li className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2 shadow-xs">
      <span className="mt-0.5">
        {busy ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : failed ? (
          <TriangleAlert className="size-4 text-destructive" />
        ) : (
          <FileText className="size-4 text-primary" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{u.name}</span>
        <span className={cn("block text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          {line}
          {meta && pages ? ` · ${pages}` : ""}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${u.name}`}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </li>
  );
}

// ---- the check card ----

const fieldClass = "h-9";
const selectClass =
  "h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function Field({ label: name, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{name}</span>
      {children}
    </label>
  );
}

function CheckCard({
  card,
  setCard,
  error,
  saveError,
  saving,
  files,
  onBack,
  onConfirm,
}: {
  card: Card;
  setCard: (c: Card) => void;
  error: string | null;
  saveError: string | null;
  saving: boolean;
  files: number;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const set = <K extends keyof Card>(k: K, v: Card[K]) => setCard({ ...card, [k]: v });
  const text = (k: "title" | "court" | "caseNumber" | "client" | "kind", placeholder = "Not given") => (
    <Input className={fieldClass} value={card[k]} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
  );
  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          The draft could not be made ({error}). Fill in what you know.
        </p>
      )}
      <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-5">
        <p className="mb-4 text-sm text-muted-foreground">
          Check what we understood. Anything left blank was not in what you gave us; change anything here.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Title">{text("title", "e.g. Perera v. Silva")}</Field>
          </div>
          <Field label="Court">{text("court")}</Field>
          <Field label="Case number">{text("caseNumber")}</Field>
          <Field label="We act for the">
            <select
              className={selectClass}
              value={card.side}
              onChange={(e) => set("side", e.target.value as Card["side"])}
            >
              <option value="">Not given</option>
              {SIDES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stage">
            <select
              className={selectClass}
              value={card.stage}
              onChange={(e) => set("stage", e.target.value as Card["stage"])}
            >
              <option value="">Not given</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Client">{text("client")}</Field>
          <Field label="Kind of case">{text("kind")}</Field>
          <Field label="Next date">
            <Input
              type="date"
              className={fieldClass}
              value={card.nextDate?.date ?? ""}
              onChange={(e) =>
                set("nextDate", e.target.value ? { date: e.target.value, purpose: card.nextDate?.purpose ?? "" } : null)
              }
            />
          </Field>
          <Field label="For">
            <Input
              className={fieldClass}
              value={card.nextDate?.purpose ?? ""}
              placeholder={card.nextDate ? "trial, answer, calling…" : "Set a date first"}
              disabled={!card.nextDate}
              onChange={(e) => card.nextDate && set("nextDate", { ...card.nextDate, purpose: e.target.value })}
            />
          </Field>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Other parties</p>
          <ul className="flex flex-col gap-2">
            {card.parties.map((p, i) => (
              <li key={i} className="flex gap-2">
                <Input
                  className={cn(fieldClass, "flex-1")}
                  value={p.name}
                  aria-label="Name"
                  onChange={(e) =>
                    set(
                      "parties",
                      card.parties.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <select
                  className={cn(selectClass, "w-36 shrink-0")}
                  aria-label="Role"
                  value={p.role}
                  onChange={(e) =>
                    set(
                      "parties",
                      card.parties.map((x, j) => (j === i ? { ...x, role: e.target.value as typeof p.role } : x)),
                    )
                  }
                >
                  {PARTY_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {label(r)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${p.name}`}
                  onClick={() =>
                    set(
                      "parties",
                      card.parties.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={() => set("parties", [...card.parties, { name: "", role: "opposing_party" }])}
          >
            <Plus /> Add a party
          </Button>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Missing facts</p>
          {card.missing.length === 0 && <p className="text-sm text-muted-foreground">None noted.</p>}
          <ul className="flex flex-col gap-3">
            {card.missing.map((m, i) => (
              <li key={i} className="flex gap-2">
                <div className="flex flex-1 flex-col gap-1">
                  <Input
                    className={fieldClass}
                    value={m.fact}
                    aria-label="Missing fact"
                    onChange={(e) =>
                      set(
                        "missing",
                        card.missing.map((x, j) => (j === i ? { ...x, fact: e.target.value } : x)),
                      )
                    }
                  />
                  <Input
                    className="h-8 text-xs text-muted-foreground"
                    value={m.why}
                    aria-label="Why it matters"
                    onChange={(e) =>
                      set(
                        "missing",
                        card.missing.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove this fact"
                  onClick={() =>
                    set(
                      "missing",
                      card.missing.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onConfirm} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          Looks right
        </Button>
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          Back
        </Button>
        {files > 0 && (
          <span className="text-xs text-muted-foreground">
            {files} {files === 1 ? "file goes" : "files go"} into the case
          </span>
        )}
      </div>
    </div>
  );
}
