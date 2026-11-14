"use client";
// Just after sign-up Clerk's webhook may not have made the account yet: say so and look again every 2 s, rather
// than show a server error (semantic validation, onboarding, 2026-11-14).
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AccountPending() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [router]);
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Setting up your account…
    </p>
  );
}
