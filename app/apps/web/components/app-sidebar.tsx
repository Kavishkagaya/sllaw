"use client";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { Loader2, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useChatStore } from "@/stores/chat-store";

type Chat = { id: string; title: string; updatedAt: Date };

const DAY = 86_400_000;
const groupOf = (d: Date) => {
  const age = Date.now() - new Date(d).getTime();
  return age < DAY ? "Today" : age < 7 * DAY ? "Previous 7 days" : "Older";
};

export function AppSidebar({ chats, error }: { chats: Chat[]; error?: string }) {
  const path = usePathname();
  const router = useRouter();
  const busy = useChatStore((s) => s.busy);
  const unread = useChatStore((s) => s.unread);
  // the list is rendered on the server: re-render it when a chat was created or an answer stored
  const listVersion = useChatStore((s) => s.listVersion);
  useEffect(() => {
    if (listVersion) router.refresh();
  }, [listVersion, router]);
  const groups = Map.groupBy(chats, (c) => groupOf(c.updatedAt));
  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <Link href="/chats" className="px-1 py-1">
          <Brand />
        </Link>
        <Button asChild variant="outline" className="justify-start">
          <Link href="/chats">
            <SquarePen /> New chat
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        {error && <p className="px-4 py-2 text-xs text-muted-foreground">{error}</p>}
        {!error && !chats.length && <p className="px-4 py-2 text-xs text-muted-foreground">Your chats show here.</p>}
        {[...groups].map(([label, items]) => (
          <SidebarGroup key={label}>
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarMenu>
              {items.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton asChild isActive={path === `/chats/${c.id}`}>
                    <Link href={`/chats/${c.id}`}>
                      {busy[c.id] && <Loader2 className="animate-spin text-muted-foreground" />}
                      <span>{c.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  {unread[c.id] && !busy[c.id] && (
                    <SidebarMenuBadge>
                      <span role="img" className="size-2 rounded-full bg-brass" aria-label="New answer" />
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-2 border-t p-3">
        <OrganizationSwitcher
          hidePersonal
          appearance={{ elements: { rootBox: "w-full", organizationSwitcherTrigger: "w-full justify-between" } }}
        />
        <div className="flex items-center justify-between">
          <UserButton showName />
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
