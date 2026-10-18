"use client";
import { useRouter } from "next/navigation";
import { Composer } from "@/components/composer";
import { SidebarTrigger } from "@/components/ui/sidebar";

const examples = [
  "What notice must a landlord give to evict a tenant under the Rent Act?",
  "Which Article of the Constitution protects freedom of expression, and what limits it?",
  "What is the limitation period for an action on a written contract?",
];

// A new chat: the client mints its id and opens it with the first question (?q=), which the chat sends.
export default function Home() {
  const router = useRouter();
  const start = (q: string) => router.push(`/chat/${crypto.randomUUID()}?q=${encodeURIComponent(q)}`);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center px-3"><SidebarTrigger /></header>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-4 pb-24">
        <div className="space-y-2 text-center">
          <h1 className="font-serif text-3xl font-semibold tracking-tight sm:text-4xl">What would you like to research?</h1>
          <p className="text-muted-foreground">Answers drawn from the Constitution and Acts of Sri Lanka, each with its citation.</p>
        </div>
        <Composer onSend={start} autoFocus />
        <div className="grid gap-2 sm:grid-cols-3">
          {examples.map((q) => (
            <button
              key={q}
              onClick={() => start(q)}
              className="rounded-lg border bg-card p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
