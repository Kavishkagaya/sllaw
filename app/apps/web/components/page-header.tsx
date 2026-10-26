import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";

export type Crumb = { label: string; href?: string };

/** A page's top bar: the sidebar toggle, where the page is (crumbs, the last one is this page), and its actions. */
export function PageHeader({ crumbs, children }: { crumbs: Crumb[]; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger />
      <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            {c.href ? (
              <Link href={c.href} className="shrink-0 text-muted-foreground hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium">{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
