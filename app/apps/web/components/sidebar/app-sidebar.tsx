"use client";
// The one sidebar (neethi-redesign d6): Dashboard and Cases; the open case expanded in place (its pages, its chats,
// its settings), so a lawyer always sees which case they are in; the other recent cases; quick chats (outside any
// case); the account with the usage meter at the foot. On a phone it is a drawer (ui/sidebar's Sheet).
import { ChevronDown, Folder, LayoutGrid, MessageSquarePlus, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  AccountFooter,
  ChatItem,
  Collapsed,
  type SidebarCase,
  type SidebarChat,
  type SidebarMeter,
  useChatListRefresh,
} from "./shared";

/** The case the page is in: its line under the title (court · next date) and its chats. */
export type OpenCase = SidebarCase & { line: string; files: number; chats: SidebarChat[] };

export function AppSidebar({
  cases,
  chats,
  open,
  error,
  meter,
  footer,
}: {
  cases: SidebarCase[];
  chats: SidebarChat[];
  open?: OpenCase;
  error?: string;
  meter?: SidebarMeter | null;
  /** rows the server adds above the account (the admin link, rendered only for staff: this bundle never names it) */
  footer?: React.ReactNode;
}) {
  const path = usePathname();
  useChatListRefresh();
  const others = cases.filter((c) => c.id !== open?.id).slice(0, open ? 4 : 5);
  return (
    <Sidebar>
      <SidebarHeader className="gap-3 p-3">
        <Link href="/dashboard" className="rounded-md px-1.5 py-1.5" aria-label="Neethi, dashboard">
          <Brand />
        </Link>
        <Link
          href="/cases/new"
          className="flex h-9 items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" /> New case
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/dashboard"}>
                <Link href="/dashboard">
                  <LayoutGrid /> <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/cases" || path === "/cases/new"}>
                <Link href="/cases">
                  <Folder /> <span>Cases</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {open && <OpenCaseTree open={open} path={path} />}
        </SidebarGroup>
        {error && <p className="px-4 py-2 text-xs text-muted-foreground">{error}</p>}
        {others.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="label-mono text-[10px]">
              {open ? "Other cases" : "Recent cases"}
            </SidebarGroupLabel>
            <SidebarMenu>
              {others.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton asChild>
                    <Link href={`/cases/${c.id}`}>
                      <span>{c.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {cases.length > others.length + (open ? 1 : 0) && (
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
          <SidebarGroupLabel className="label-mono text-[10px]">Quick chats</SidebarGroupLabel>
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
      <AccountFooter meter={meter}>{footer}</AccountFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The open case, expanded under Cases: its title and line, then Overview, Files, its chats and Case settings. */
function OpenCaseTree({ open, path }: { open: OpenCase; path: string }) {
  const base = `/cases/${open.id}`;
  const sub = "pl-3.5";
  return (
    <div className="mt-1 ml-1 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
      <Link
        href={base}
        className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 shadow-xs"
        aria-current={path === base ? "page" : undefined}
      >
        <span className="w-1 self-stretch rounded-full bg-primary" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{open.title}</span>
          {open.line && <span className="label-mono truncate text-[9.5px] text-muted-foreground">{open.line}</span>}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={path === base} className={sub}>
            <Link href={base}>Overview</Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={path.startsWith(`${base}/files`)} className={sub}>
            <Link href={`${base}/files`}>Files</Link>
          </SidebarMenuButton>
          {open.files > 0 && <SidebarMenuBadge className="label-mono text-[10px]">{open.files}</SidebarMenuBadge>}
        </SidebarMenuItem>
      </SidebarMenu>
      <div className="flex items-center justify-between pt-2 pr-1 pl-3.5">
        <span className="label-mono text-[9.5px] text-muted-foreground">Chats</span>
        <Link
          href={`${base}/chats`}
          title="New chat in this case"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <MessageSquarePlus className="size-3.5" /> <span className="sr-only">New chat in this case</span>
        </Link>
      </div>
      <SidebarMenu>
        {!open.chats.length && (
          <p className="px-3.5 py-1 text-xs text-muted-foreground">
            Chats here read every question with the case's facts.
          </p>
        )}
        <Collapsed
          items={open.chats}
          first={6}
          render={(c) => <ChatItem key={c.id} chat={c} href={`${base}/chats/${c.id}`} className={sub} />}
        />
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={path === `${base}/settings`} className={sub}>
            <Link href={`${base}/settings`}>Case settings</Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}
