import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

const points = [
  "Every answer cites the section it rests on, with the text one click away.",
  "The law as it stands today, with the amendments that changed it.",
  "A workspace for each case: its papers, its dates, its chats.",
];

// Sign-in and sign-up: the Clerk form on paper, beside an ink panel with the arch drawn large over the dot field.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#16140f] p-10 text-[#f3f1ec] lg:flex">
        <div
          aria-hidden
          className="absolute inset-0 [background-image:radial-gradient(circle,rgb(208_106_122/0.22)_1px,transparent_1.3px)] [background-size:14px_14px] [mask-image:radial-gradient(ellipse_at_70%_80%,black,transparent_70%)]"
        />
        <svg
          aria-hidden
          viewBox="0 0 96 96"
          className="pointer-events-none absolute -right-16 -bottom-24 size-[30rem] text-[#7d1d2c]"
        >
          <path d="M24 78V46a24 24 0 0 1 48 0v32" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M33 78V46a15 15 0 0 1 30 0v32" fill="none" stroke="currentColor" strokeWidth="1" opacity=".6" />
        </svg>
        <Link href="/" className="relative w-fit [&_span]:text-[#f3f1ec] [&_svg]:text-[#d06a7a]">
          <Brand size="lg" />
        </Link>
        <div className="relative max-w-md space-y-8">
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-[-0.035em]">
            Your AI colleague for Sri Lankan law.
          </h1>
          <ul className="space-y-4 text-sm text-[#c9c2b6]">
            {points.map((text) => (
              <li key={text} className="flex gap-3">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#d06a7a]" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-[#a8a196]">
          A research aid, not legal advice. Check the cited text before relying on it.
        </p>
      </aside>
      <main className="dots flex flex-col p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="lg:invisible">
            <Brand />
          </Link>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">{children}</div>
      </main>
    </div>
  );
}
