import { BookOpenCheck, History, Quote } from "lucide-react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

const points = [
  { icon: Quote, text: "Every answer cites the section it rests on, with the text one click away." },
  { icon: History, text: "Provisions read as at a date, with the amendments that changed them." },
  { icon: BookOpenCheck, text: "The Constitution, Acts and revised editions from 1956 to today." },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[1fr_1.1fr]">
      {/* the dark tokens in either theme: navy and brass */}
      <aside className="dark relative hidden overflow-hidden flex-col justify-between border-r bg-sidebar p-10 text-foreground lg:flex">
        <span aria-hidden className="pointer-events-none absolute -right-10 -bottom-32 font-serif text-[32rem] leading-none text-primary/[0.07] select-none">§</span>
        <Brand />
        <div className="max-w-md space-y-8">
          <h1 className="font-serif text-4xl leading-tight font-semibold">The law of Sri Lanka, answered with its sources.</h1>
          <ul className="space-y-4 text-sm text-muted-foreground">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground/70">Research aid, not legal advice. Check the cited text before relying on it.</p>
      </aside>
      <main className="flex flex-col p-6">
        <div className="flex items-center justify-between">
          <Brand className="lg:invisible" />
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">{children}</div>
      </main>
    </div>
  );
}
