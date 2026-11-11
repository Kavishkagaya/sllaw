"use client";
// The case office on the page: the office (from office.open, kept fresh in the query cache) and `run`, which sends
// operations to office.change and puts the result in the cache. Every widget reads and writes through this, so a
// change anywhere shows everywhere at once. A refused change (a pinned widget, bad data) shows its message on top.
import type { AppRouter } from "@sllaw/api";
import type { Office, Op } from "@sllaw/office";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { createContext, useCallback, useContext, useState } from "react";
import { useTRPC } from "@/trpc/client";

export type OfficeData = inferRouterOutputs<AppRouter>["office"]["open"];

type Value = {
  caseId: string;
  office: Office;
  today: string;
  run: (...ops: Op[]) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => void;
  setOffice: (office: Office, version: number) => void;
};

const Ctx = createContext<Value | null>(null);

export function useOffice() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOffice outside OfficeProvider");
  return v;
}

export function OfficeProvider({
  caseId,
  initial,
  children,
}: {
  caseId: string;
  initial: OfficeData;
  children: React.ReactNode;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const key = trpc.office.open.queryKey({ caseId });
  // always fetched again on mount and focus: the agent may have changed the case from a chat
  const { data } = useQuery({ ...trpc.office.open.queryOptions({ caseId }), initialData: initial, staleTime: 0 });
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: key });
  }, [qc, key]);
  const change = useMutation(
    trpc.office.change.mutationOptions({
      onSuccess: (r) => {
        qc.setQueryData(key, (old) => old && { ...old, office: r.office, version: r.version });
        setError(null);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const run = useCallback(
    (...ops: Op[]) =>
      change
        .mutateAsync({ caseId, ops })
        .then(() => true)
        .catch(() => false),
    [change, caseId],
  );
  return (
    <Ctx.Provider
      value={{
        caseId,
        office: data.office,
        today: data.today,
        run,
        pending: change.isPending,
        error,
        clearError: () => setError(null),
        refresh,
        setOffice: (office, version) => qc.setQueryData(key, (old) => old && { ...old, office, version }),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
