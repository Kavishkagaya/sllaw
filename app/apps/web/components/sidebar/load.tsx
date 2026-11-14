import { Shield } from "lucide-react";
import Link from "next/link";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { serverApi } from "@/trpc/server";
import type { SidebarMeter } from "./shared";

/** What the one sidebar shows on every signed-in page: the cases, the quick chats, the usage meter, and the admin
 *  row for staff. Loaded on the server by both layouts ((main) and a case's). */
export async function loadSidebar() {
  const api = await serverApi();
  const [[cases, chats], admin, usage] = await Promise.all([
    Promise.all([api.case.list(), api.chat.list()]).catch((e: Error) => [e, e] as const),
    api.admin.check().catch(() => false), // NOT_FOUND for everyone but staff
    api.usage.mine().catch(() => null),
  ]);
  // the allowance the lawyer hits first: the fullest limit that has a max
  let meter: SidebarMeter | null = null;
  for (const l of usage?.limits ?? []) {
    if (l.max == null || l.used == null) continue;
    const pct = (l.used / l.max) * 100;
    if (!meter || pct > meter.pct) meter = { label: l.label, pct };
  }
  return {
    cases: cases instanceof Error ? [] : cases,
    chats: chats instanceof Error ? [] : chats,
    error: cases instanceof Error ? cases.message : undefined,
    meter,
    footer: admin ? <AdminLink /> : undefined,
  };
}

// Built here, on the server, and only for staff: a normal user's page and scripts never contain it.
function AdminLink() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild>
          <Link href="/admin">
            <Shield /> <span>Admin</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
