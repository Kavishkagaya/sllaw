"use client";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";

type Chat = { id: string; title: string; updatedAt: Date };

const DAY = 86_400_000;
const groupOf = (d: Date) => {
  const age = Date.now() - new Date(d).getTime();
  return age < DAY ? "Today" : age < 7 * DAY ? "Previous 7 days" : "Older";
};

export function AppSidebar({ chats, error }: { chats: Chat[]; error?: string }) {
  const path = usePathname();
  const groups = Map.groupBy(chats, (c) => groupOf(c.updatedAt));
  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <Link href="/" className="px-1 py-1"><Brand /></Link>
        <Button asChild variant="outline" className="justify-start">
          <Link href="/"><SquarePen /> New chat</Link>
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
                  <SidebarMenuButton asChild isActive={path === `/chat/${c.id}`}>
                    <Link href={`/chat/${c.id}`}><span>{c.title}</span></Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-2 border-t p-3">
        <OrganizationSwitcher hidePersonal appearance={{ elements: { rootBox: "w-full", organizationSwitcherTrigger: "w-full justify-between" } }} />
        <div className="flex items-center justify-between">
          <UserButton showName />
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
