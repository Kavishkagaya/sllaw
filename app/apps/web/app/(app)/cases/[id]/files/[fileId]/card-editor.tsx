"use client";
// Correcting a file's card: any field and the type. A new type reads the file again for that type's fields (and keeps
// what was typed). Saved at once; no history, no undo (user, 2026-11-11).
import { useMutation } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { docTypeLabel } from "@/lib/format";
import { useTRPC } from "@/trpc/client";

type FieldValue = string | string[] | null;
type Spec = { key: string; label: string; kind: "text" | "list"; hint: string };
export type EditableCard = {
  docType: string;
  title: string;
  summary: string;
  court: string | null;
  caseNumbers: string[];
  parties: { name: string; role: string }[];
  dates: { date: string; what: string }[];
  lawsCited: string[];
  tags: string[];
  fields: Record<string, FieldValue>;
};

const SEP = " — ";
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const pairs = (s: string) =>
  lines(s).map((l) => {
    const i = l.indexOf(SEP.trim());
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });

export function CardEditor({
  caseId,
  fileId,
  card,
  specs,
  docTypes,
}: {
  caseId: string;
  fileId: string;
  card: EditableCard;
  specs: Spec[];
  docTypes: readonly string[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const edit = useMutation(trpc.case.editFile.mutationOptions());
  const [open, setOpen] = useState(false);
  const initial = () => ({
    docType: card.docType,
    title: card.title,
    summary: card.summary,
    court: card.court ?? "",
    caseNumbers: card.caseNumbers.join("\n"),
    parties: card.parties.map((p) => `${p.name}${SEP}${p.role}`).join("\n"),
    dates: card.dates.map((d) => `${d.date}${SEP}${d.what}`).join("\n"),
    lawsCited: card.lawsCited.join("\n"),
    tags: card.tags.join(", "),
    fields: Object.fromEntries(
      specs.map((s) => {
        const v = card.fields[s.key];
        return [s.key, Array.isArray(v) ? v.join("\n") : (v ?? "")];
      }),
    ) as Record<string, string>,
  });
  const [form, setForm] = useState(initial);
  const set = (k: keyof ReturnType<typeof initial>, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const was = initial();
    const patch: Record<string, unknown> = {};
    if (form.docType !== was.docType) patch.docType = form.docType;
    if (form.title !== was.title) patch.title = form.title.trim();
    if (form.summary !== was.summary) patch.summary = form.summary.trim();
    if (form.court !== was.court) patch.court = form.court.trim() || null;
    if (form.caseNumbers !== was.caseNumbers) patch.caseNumbers = lines(form.caseNumbers);
    if (form.parties !== was.parties) patch.parties = pairs(form.parties).map(([name, role]) => ({ name, role }));
    if (form.dates !== was.dates) patch.dates = pairs(form.dates).map(([date, what]) => ({ date, what }));
    if (form.lawsCited !== was.lawsCited) patch.lawsCited = lines(form.lawsCited);
    if (form.tags !== was.tags)
      patch.tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    const fields: Record<string, FieldValue> = {};
    for (const s of specs) {
      const v = form.fields[s.key] ?? "";
      if (v === was.fields[s.key]) continue;
      fields[s.key] = s.kind === "list" ? lines(v) : v.trim() || null;
    }
    if (Object.keys(fields).length) patch.fields = fields;
    if (Object.keys(patch).length) await edit.mutateAsync({ caseId, fileId, patch });
    setOpen(false);
    router.refresh();
  }

  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => (setForm(initial()), setOpen(true))}>
        <Pencil /> Edit details
      </Button>
    );

  const retype = form.docType !== card.docType;
  return (
    <form onSubmit={save} className="mt-6 grid gap-5 rounded-lg border p-4 sm:p-5">
      <div className="grid gap-1.5">
        <Label htmlFor="card-type">Type</Label>
        <select
          id="card-type"
          value={form.docType}
          onChange={(e) => set("docType", e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {docTypes.map((t) => (
            <option key={t} value={t}>
              {docTypeLabel(t)}
            </option>
          ))}
        </select>
        {retype && (
          <p className="text-xs text-muted-foreground">
            Saving reads the file again for a {docTypeLabel(form.docType).toLowerCase()}'s fields. What you typed stays.
          </p>
        )}
      </div>
      <Text id="card-title" label="Title" value={form.title} onChange={(v) => set("title", v)} />
      <Text id="card-summary" label="Summary" value={form.summary} onChange={(v) => set("summary", v)} long />
      {!retype &&
        specs.map((s) => (
          <Text
            key={s.key}
            id={`card-f-${s.key}`}
            label={s.label}
            hint={s.kind === "list" ? "one per line" : undefined}
            value={form.fields[s.key] ?? ""}
            onChange={(v) => setForm((f) => ({ ...f, fields: { ...f.fields, [s.key]: v } }))}
            long={s.kind === "list" || s.key.length > 12}
          />
        ))}
      <Text id="card-court" label="Court" value={form.court} onChange={(v) => set("court", v)} />
      <Text
        id="card-numbers"
        label="Case numbers"
        hint="one per line"
        value={form.caseNumbers}
        onChange={(v) => set("caseNumbers", v)}
        long
      />
      <Text
        id="card-parties"
        label="Parties"
        hint="one per line: name — role"
        value={form.parties}
        onChange={(v) => set("parties", v)}
        long
      />
      <Text
        id="card-dates"
        label="Dates"
        hint="one per line: YYYY-MM-DD — what"
        value={form.dates}
        onChange={(v) => set("dates", v)}
        long
      />
      <Text
        id="card-laws"
        label="Laws cited"
        hint="one per line"
        value={form.lawsCited}
        onChange={(v) => set("lawsCited", v)}
        long
      />
      <Text id="card-tags" label="Tags" hint="separated by commas" value={form.tags} onChange={(v) => set("tags", v)} />
      {edit.error && <p className="text-sm text-destructive">Not saved: {edit.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={edit.isPending}>
          {edit.isPending && <Loader2 className="animate-spin" />}
          {edit.isPending && retype ? "Reading the file…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={edit.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Text({
  id,
  label,
  hint,
  value,
  onChange,
  long,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  long?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {hint && <span className="font-normal text-muted-foreground"> ({hint})</span>}
      </Label>
      {long ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
