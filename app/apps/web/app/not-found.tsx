import Link from "next/link";
import { Brand } from "@/components/brand";
import { ArchDrawing } from "@/components/drawn";

// Any page that is not there (and a case or chat that is not the user's: the server answers not found).
export default function NotFound() {
  return (
    <main className="dots flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <ArchDrawing />
      <div>
        <p className="label-mono text-[11px] text-primary">404 · Not found</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">This page is not here.</h1>
        <p className="mt-2 max-w-sm text-[15px] text-muted-foreground">
          It may have moved, or the link may be wrong. If it was a case or a chat, it is not one of yours.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-[15px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          Go to the dashboard
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg border bg-card px-5 text-[15px] hover:bg-accent"
        >
          Home
        </Link>
      </div>
      <Brand className="mt-6 opacity-70" />
    </main>
  );
}
