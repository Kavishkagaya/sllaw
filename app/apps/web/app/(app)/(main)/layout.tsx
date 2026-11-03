import { Shield } from "lucide-react";
import Link from "next/link";
import { MainSidebar } from "@/components/sidebar/main-sidebar";
import { SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { serverApi } from "@/trpc/server";

// Outside a case: home, cases, quick chats.
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const api = await serverApi();
  const [[cases, chats], admin] = await Promise.all([
    Promise.all([api.case.list(), api.chat.list()]).catch((e: Error) => [e, e] as const),
    api.admin.check().catch(() => false), // NOT_FOUND for everyone but staff
  ]);
  const error = cases instanceof Error ? cases.message : undefined;
  return (
    <>
      <MainSidebar
        cases={cases instanceof Error ? [] : cases}
        chats={chats instanceof Error ? [] : chats}
        error={error}
        footer={admin && <AdminLink />}
      />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
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
