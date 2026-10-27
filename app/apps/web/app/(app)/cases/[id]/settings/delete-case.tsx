"use client";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/trpc/client";

export function DeleteCase({ id, title }: { id: string; title: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const del = useMutation(trpc.case.delete.mutationOptions());
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 /> Delete case
      </Button>
      <ConfirmDelete
        open={open}
        onOpenChange={setOpen}
        title={`Delete "${title}"?`}
        description="The case, all its files and its chats are deleted for good."
        action="Delete case"
        onConfirm={async () => {
          await del.mutateAsync({ caseId: id });
          router.push("/cases");
          router.refresh();
        }}
      />
    </>
  );
}
