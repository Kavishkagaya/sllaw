"use client";
// A case's title and facts: a new case (then its page opens) or an edit of one (then back to it).
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/trpc/client";

export function CaseForm({ initial }: { initial?: { id: string; title: string; facts: string } }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [facts, setFacts] = useState(initial?.facts ?? "");
  const create = useMutation(trpc.case.create.mutationOptions());
  const update = useMutation(trpc.case.update.mutationOptions());
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = { title: title.trim(), facts: facts.trim() };
    const id = initial
      ? (await update.mutateAsync({ caseId: initial.id, ...input })).id
      : (await create.mutateAsync(input)).id;
    router.push(`/cases/${id}`);
    router.refresh();
  };

  return (
    <form onSubmit={(e) => void submit(e).catch(() => {})} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Perera v. Silva, DC Colombo 12345/L"
          maxLength={200}
          required
          autoFocus={!initial}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="facts">Facts</Label>
        <Textarea
          id="facts"
          value={facts}
          onChange={(e) => setFacts(e.target.value)}
          placeholder="Who the parties are, what happened, what the client wants. A few lines are enough; the files fill in the rest."
          className="min-h-48"
          maxLength={20_000}
        />
        <p className="text-xs text-muted-foreground">The AI reads these with the case's files when you ask about it.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending && <Loader2 className="animate-spin" />}
          {initial ? "Save" : "Create case"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={initial ? `/cases/${initial.id}` : "/cases"}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
