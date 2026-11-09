"use client";
// The admin side's sidebar (/admin, platform staff only): the dashboard, usage and users, and the way back.
import { ArrowLeft, ChartColumn, Gauge, LayoutDashboard, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { AccountFooter } from "../sidebar/shared";

const items = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, match: [] as string[] },
  { href: "/admin/usage", label: "Usage", icon: ChartColumn, match: ["/admin/usage", "/admin/workspaces"] },
  { href: "/admin/users", label: "Users", icon: Users, match: ["/admin/users"] },
  { href: "/admin/plans", label: "Plans", icon: Gauge, match: ["/admin/plans"] },
];

export function AdminSidebar() {
  const path = usePathname();
  return (
    <Sidebar>
      <SidebarHeader className="p-3">
        <Link href="/admin" className="flex items-center gap-2 px-1 py-1">
          <Brand />
          <span className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-muted-foreground uppercase">
            Admin
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarMenu>
            {items.map((i) => (
              <SidebarMenuItem key={i.href}>
                <SidebarMenuButton
                  asChild
                  isActive={i.match.length ? i.match.some((m) => path.startsWith(m)) : path === i.href}
                >
                  <Link href={i.href}>
                    <i.icon /> <span>{i.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/">
                  <ArrowLeft /> <span>Back to the app</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <AccountFooter />
      <SidebarRail />
    </Sidebar>
  );
}
