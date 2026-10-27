"use client";
// The sidebar inside a case: the case itself (switch to another, back to all cases), its pages, and its chats.
// Later case pages (documents, tasks, calendar) go in the pages list. Connections stay global, never here.
import {
  ArrowLeft,
  Briefcase,
  Check,
  ChevronsUpDown,
  FileText,
  LayoutDashboard,
  MessageSquarePlus,
  Plus,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

export function CaseSidebar({
  current,
  cases,
  chats,
}: {
  current: SidebarCase;
  cases: SidebarCase[];
  chats: SidebarChat[];
}) {
  const path = usePathname();
  useChatListRefresh();
  const base = `/cases/${current.id}`;
  const pages = [
    { href: base, label: "Overview", icon: LayoutDashboard, active: path === base },
    { href: `${base}/files`, label: "Files", icon: FileText, active: path.startsWith(`${base}/files`) },
  ];
  return (
    <Sidebar>
      <SidebarHeader className="gap-1 p-3">
        <Link
          href="/cases"
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> All cases
        </Link>
        <CaseSwitcher current={current} cases={cases} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {pages.map((p) => (
              <SidebarMenuItem key={p.href}>
                <SidebarMenuButton asChild isActive={p.active}>
                  <Link href={p.href}>
                    <p.icon /> <span>{p.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupAction asChild title="New chat in this case">
            <Link href={`${base}/chats`}>
              <MessageSquarePlus /> <span className="sr-only">New chat in this case</span>
            </Link>
          </SidebarGroupAction>
          <SidebarMenu>
            {!chats.length && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Chats here read every question with the case's facts.
              </p>
            )}
            <Collapsed
              items={chats}
              first={10}
              render={(c) => <ChatItem key={c.id} chat={c} href={`${base}/chats/${c.id}`} />}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <AccountFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={path === `${base}/settings`}>
              <Link href={`${base}/settings`}>
                <Settings /> <span>Case settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </AccountFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The case's name; opens a menu to jump to another case (its overview), see them all, or start a new one. */
function CaseSwitcher({ current, cases }: { current: SidebarCase; cases: SidebarCase[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate font-serif text-base leading-tight font-semibold">
            {current.title}
          </span>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-60">
        <DropdownMenuLabel>Recent cases</DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {cases.slice(0, 10).map((c) => (
            <DropdownMenuItem key={c.id} asChild>
              <Link href={`/cases/${c.id}`}>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.id === current.id && <Check />}
              </Link>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/cases">
            <Briefcase /> All cases
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/cases/new">
            <Plus /> New case
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
