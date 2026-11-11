"use client";
// A change the agent made to the case office in this chat (tool caseUpdate): what it did, and a link to the case page.
import { LayoutDashboard, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function CaseChange({ caseId, summary }: { caseId: string; summary: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Sparkles className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">{summary}</span>
      <Button asChild size="sm" variant="ghost">
        <Link href={`/cases/${caseId}`}>
          <LayoutDashboard /> Case page
        </Link>
      </Button>
    </div>
  );
}
