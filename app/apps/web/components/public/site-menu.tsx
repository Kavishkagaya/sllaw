"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

// The public header's menu on a phone (landing-motion): the links, Sign in and the theme behind one button, so the
// bar holds only the logo, Start free and this. Closes on a pick, on Escape, and when the page scrolls.
export function SiteMenu({ nav, signedIn }: { nav: { href: string; label: string }[]; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    addEventListener("scroll", close, { passive: true });
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("scroll", close);
    };
  }, [open]);
  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Menu"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-11 items-center justify-center rounded-lg text-foreground hover:bg-accent"
      >
        {open ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 border-b bg-background px-4 pt-2 pb-5 shadow-[0_24px_40px_-24px_rgb(22_20_15/0.45)]">
          <nav aria-label="Site" className="flex flex-col">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center border-b text-[17px] font-medium"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mt-4 flex items-center gap-3">
            {!signedIn && (
              <Link
                href="/sign-in"
                className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-input text-[15px]"
              >
                Sign in
              </Link>
            )}
            <ThemeToggle />
          </div>
        </div>
      )}
    </div>
  );
}
