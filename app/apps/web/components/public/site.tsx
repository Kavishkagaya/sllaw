import Link from "next/link";
import { Brand } from "@/components/brand";
import { SiteMenu } from "@/components/public/site-menu";
import { ThemeToggle } from "@/components/theme-toggle";

// The public site's frame (neethi-redesign d3, d4): the header and the footer every public page shares. Signed in,
// the header offers "Open Neethi" (to /dashboard) in place of Sign in and Start free.
const NAV = [
  { href: "/#product", label: "Product" },
  { href: "/coverage", label: "Coverage" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

/** One size for every button on the public site (landing-motion: uniform, 40 px on a phone, 44 px from sm). */
export const btn =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-[14px] font-medium whitespace-nowrap sm:min-h-11 sm:px-5 sm:text-[15px]";
export const cta = `${btn} bg-primary text-primary-foreground hover:bg-primary/90`;
export const ctaQuiet = `${btn} border border-input bg-card text-foreground hover:bg-accent`;

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="relative border-b bg-background">
      <div className="mx-auto flex max-w-[1200px] items-center gap-x-7 px-4 py-2 sm:px-6 sm:py-3">
        <Link href="/" aria-label="Neethi, home" className="py-2">
          <Brand />
        </Link>
        <nav aria-label="Site" className="-mx-2 flex flex-1 gap-1 text-[14.5px] max-sm:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex min-h-11 items-center px-2 text-muted-foreground hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
          <span className="max-sm:hidden">
            <ThemeToggle />
          </span>
          {signedIn ? (
            <Link href="/dashboard" className={cta}>
              Open Neethi
            </Link>
          ) : (
            <>
              <Link
                href="/sign-in"
                className="flex min-h-11 items-center px-3 text-[14.5px] hover:text-primary max-sm:hidden"
              >
                Sign in
              </Link>
              <Link href="/sign-up" className={cta}>
                Start free
              </Link>
            </>
          )}
          <SiteMenu nav={NAV} signedIn={signedIn} />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-[13.5px] text-muted-foreground sm:px-6">
        <Brand />
        <span className="flex-1 basis-60">Research help for lawyers, not legal advice.</span>
        {[
          ["/coverage", "Coverage"],
          ["/pricing", "Pricing"],
          ["/privacy", "Privacy"],
          ["/terms", "Terms"],
        ].map(([href, label]) => (
          <Link key={href} href={href!} className="flex min-h-11 items-center hover:text-foreground">
            {label}
          </Link>
        ))}
      </div>
    </footer>
  );
}

/** A section's small label above its heading: Geist Mono capitals in oxblood. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`label-mono text-[11.5px] text-primary ${className ?? ""}`}>{children}</div>;
}

/** The three plans (prices to be announced), on the landing and on /pricing. */
export function Plans() {
  const tick = "text-[14.5px] leading-[1.9]";
  return (
    <div className="grid gap-5 md:grid-cols-3">
      <div className="flex flex-col gap-3.5 rounded-2xl border bg-card p-7">
        <div className="font-semibold">Free</div>
        <div className="text-4xl font-semibold tracking-[-0.03em]">Rs. 0</div>
        <ul className={`list-disc pl-5 text-muted-foreground ${tick}`}>
          <li>Quick questions on the law</li>
          <li>Your first case</li>
          <li>Cited, checked answers</li>
        </ul>
        <Link href="/sign-up" className={`mt-auto ${ctaQuiet}`}>
          Start free
        </Link>
      </div>
      <div className="flex flex-col gap-3.5 rounded-2xl bg-[#16140f] p-7 text-[#f3f1ec] dark:border dark:border-white/10">
        <div className="flex items-center gap-2.5 font-semibold">
          Lawyer
          <span className="label-mono rounded bg-[#7d1d2c] px-1.5 py-0.5 text-[9.5px] text-white">Most chosen</span>
        </div>
        <div className="text-4xl font-semibold tracking-[-0.03em]">To be announced</div>
        <ul className={`list-disc pl-5 text-[#b8b1a4] ${tick}`}>
          <li>Unlimited cases and files</li>
          <li>Case diary and hearing prep</li>
          <li>Higher monthly usage</li>
        </ul>
        <Link href="/sign-up" className={`mt-auto ${btn} bg-[#7d1d2c] text-white hover:bg-[#6b1825]`}>
          Start free
        </Link>
      </div>
      <div className="flex flex-col gap-3.5 rounded-2xl border bg-card p-7">
        <div className="font-semibold">Chambers</div>
        <div className="text-4xl font-semibold tracking-[-0.03em]">To be announced</div>
        <ul className={`list-disc pl-5 text-muted-foreground ${tick}`}>
          <li>Everything in Lawyer</li>
          <li>
            Cases shared with your juniors <span className="label-mono text-[9.5px] text-primary">Coming soon</span>
          </li>
          <li>One bill for the chambers</li>
        </ul>
        <Link href="/sign-up" className={`mt-auto ${ctaQuiet}`}>
          Start free
        </Link>
      </div>
    </div>
  );
}
