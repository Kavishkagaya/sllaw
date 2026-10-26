import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { serverApi } from "../../trpc/server";

// The signed-in shell: chats in the sidebar, the page beside it.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const chats = await (await serverApi()).chat.list().catch((e: Error) => e);
  return (
    <SidebarProvider>
      <AppSidebar
        chats={chats instanceof Error ? [] : chats}
        error={chats instanceof Error ? chats.message : undefined}
      />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </SidebarProvider>
  );
}
