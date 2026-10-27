"use client";
// What both sidebars share: a chat's row (spinner while it answers, a dot for an answer not seen yet), a list that
// shows the first few with "Show more", the account footer, and the refresh that keeps the server-rendered lists
// current when a chat is created or an answer stored.
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarFooter, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useChatStore } from "@/stores/chat-store";

export type SidebarChat = { id: string; title: string; updatedAt: Date };
export type SidebarCase = { id: string; title: string };

/** The lists are rendered on the server: render them again when a chat was created or an answer stored. */
export function useChatListRefresh() {
  const router = useRouter();
  const listVersion = useChatStore((s) => s.listVersion);
  useEffect(() => {
    if (listVersion) router.refresh();
  }, [listVersion, router]);
}

export function ChatItem({ chat, href }: { chat: SidebarChat; href: string }) {
  const path = usePathname();
  const busy = useChatStore((s) => s.busy[chat.id]);
  const unread = useChatStore((s) => s.unread[chat.id]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={path === href}>
        <Link href={href}>
          {busy && <Loader2 className="animate-spin text-muted-foreground" />}
          <span>{chat.title}</span>
        </Link>
      </SidebarMenuButton>
      {unread && !busy && (
        <SidebarMenuBadge>
          <span role="img" className="size-2 rounded-full bg-brass" aria-label="New answer" />
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

export function AccountFooter({ children }: { children?: React.ReactNode }) {
  return (
    <SidebarFooter className="gap-2 border-t p-3">
      {children}
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
