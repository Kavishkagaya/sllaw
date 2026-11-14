"use client";
// What both sidebars share: a chat's row (spinner while it answers, a dot for an answer not seen yet), a list that
// shows the first few with "Show more", the account footer, and the refresh that keeps the server-rendered lists
// current when a chat is created or an answer stored.
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { Gauge, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarFooter, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useChatStore } from "@/stores/chat-store";

export type SidebarChat = { id: string; title: string; updatedAt: Date };
export type SidebarCase = { id: string; title: string };
/** The account's allowance today (or this month), as a share: the bar at the foot, linking to /usage. */
export type SidebarMeter = { label: string; pct: number };

/** The lists are rendered on the server: render them again when a chat was created or an answer stored. */
export function useChatListRefresh() {
  const router = useRouter();
  const listVersion = useChatStore((s) => s.listVersion);
  useEffect(() => {
    if (listVersion) router.refresh();
  }, [listVersion, router]);
}

export function ChatItem({ chat, href, className }: { chat: SidebarChat; href: string; className?: string }) {
  const path = usePathname();
  const busy = useChatStore((s) => s.busy[chat.id]);
  const unread = useChatStore((s) => s.unread[chat.id]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={path === href} className={className}>
        <Link href={href}>
          {busy && <Loader2 className="animate-spin text-muted-foreground" />}
          <span>{chat.title}</span>
        </Link>
      </SidebarMenuButton>
      {unread && !busy && (
        <SidebarMenuBadge>
          <span role="img" className="size-2 rounded-full bg-primary" aria-label="New answer" />
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

/** The first `first` items, then a "Show more" row that shows them all (and "Show less"). */
export function Collapsed<T>({
  items,
  first,
  render,
}: {
  items: T[];
  first: number;
  render: (item: T) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, first);
  return (
    <>
      {shown.map(render)}
      {items.length > first && (
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => setAll(!all)} className="text-xs text-muted-foreground">
            {all ? "Show less" : `Show ${items.length - first} more`}
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </>
  );
}

export function AccountFooter({ children, meter }: { children?: React.ReactNode; meter?: SidebarMeter | null }) {
  const path = usePathname();
  return (
    <SidebarFooter className="gap-2 border-t p-3">
      {children}
      <Link
        href="/usage"
        aria-current={path === "/usage" ? "page" : undefined}
        className="flex flex-col gap-1.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent"
      >
        <span className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <Gauge className="size-3.5" /> Usage
          </span>
          {meter && <span className="text-muted-foreground tabular-nums">{Math.round(meter.pct)}%</span>}
        </span>
        {meter && (
          <span className="block h-[3px] rounded-full bg-sidebar-border" title={meter.label}>
            <span
              className={
                meter.pct >= 100 ? "block h-full rounded-full bg-destructive" : "block h-full rounded-full bg-primary"
              }
              style={{ width: `${Math.min(100, Math.max(2, meter.pct))}%` }}
            />
          </span>
        )}
      </Link>
      <OrganizationSwitcher
        hidePersonal
        appearance={{ elements: { rootBox: "w-full", organizationSwitcherTrigger: "w-full justify-between" } }}
      />
      <div className="flex items-center justify-between">
        <UserButton showName />
        <ThemeToggle />
      </div>
    </SidebarFooter>
  );
}
