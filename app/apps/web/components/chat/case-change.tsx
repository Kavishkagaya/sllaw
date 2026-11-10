"use client";
// A change the agent made to the case office in this chat (tool caseUpdate): what it did, a link to the dashboard,
// and Undo. Whether it is still in place comes from the case's history, so the card is right after a reload too.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Sparkles, Undo2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/trpc/client";

export function CaseChange({ caseId, changeId, summary }: { caseId: string; changeId: string; summary: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const history = useQuery(trpc.office.history.queryOptions({ caseId }));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: trpc.office.history.queryKey({ caseId }) });
    qc.invalidateQueries({ queryKey: trpc.office.open.queryKey({ caseId }) });
  };
  const undo = useMutation(trpc.office.undo.mutationOptions({ onSettled: refresh }));
  const undone = !!history.data?.find((c) => c.id === changeId)?.undoneBy;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Sparkles className="size-4 shrink-0 text-primary" />
      <span className={undone ? "min-w-0 flex-1 text-muted-foreground line-through" : "min-w-0 flex-1"}>
        {summary}
        {undone && <span className="ml-1 no-underline">(undone)</span>}
      </span>
      <div className="flex items-center gap-1">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/cases/${caseId}`}>
            <LayoutDashboard /> Case page
          </Link>
        </Button>
        {!undone && (
          <Button
            size="sm"
            variant="ghost"
            disabled={undo.isPending || history.isLoading}
            onClick={() => undo.mutate({ caseId, changeId })}
          >
            <Undo2 /> Undo
          </Button>
        )}
      </div>
    </div>
  );
}
