"use client";
// The sidebar outside a case: home, the cases (the recent ones listed), and quick chats (plain chats outside any
// case). Inside a case the case sidebar takes its place (case-sidebar.tsx).
import { Briefcase, House, MessageSquarePlus, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { AccountFooter, ChatItem, Collapsed, type SidebarCase, type SidebarChat, useChatListRefresh } from "./shared";

export function MainSidebar({ cases, chats, error }: { cases: SidebarCase[]; chats: SidebarChat[]; error?: string }) {
  const path = usePathname();
  useChatListRefresh();
  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <Link href="/" className="px-1 py-1">
          <Brand />
        </Link>
        <Button asChild className="justify-start">
          <Link href="/cases/new">
            <Plus /> New case
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/"}>
                <Link href="/">
                  <House /> <span>Home</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/cases")}>
                <Link href="/cases">
                  <Briefcase /> <span>Cases</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {error && <p className="px-4 py-2 text-xs text-muted-foreground">{error}</p>}
        {cases.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Recent cases</SidebarGroupLabel>
            <SidebarMenu>
              {cases.slice(0, 5).map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton asChild>
                    <Link href={`/cases/${c.id}`}>
                      <span>{c.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {cases.length > 5 && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className="text-xs text-muted-foreground">
                    <Link href="/cases">All {cases.length} cases</Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>Quick chats</SidebarGroupLabel>
          <SidebarGroupAction asChild title="New quick chat">
            <Link href="/chats">
              <MessageSquarePlus /> <span className="sr-only">New quick chat</span>
            </Link>
          </SidebarGroupAction>
          <SidebarMenu>
            {!error && !chats.length && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Questions outside a case. A chat can be moved into a case later.
              </p>
            )}
            <Collapsed
              items={chats}
              first={5}
              render={(c) => <ChatItem key={c.id} chat={c} href={`/chats/${c.id}`} />}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <AccountFooter />
      <SidebarRail />
    </Sidebar>
  );
}
