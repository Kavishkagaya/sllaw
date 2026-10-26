import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { UploadTray } from "@/components/upload-tray";
import { serverApi } from "../../trpc/server";

// The signed-in shell: chats in the sidebar, the page beside it, and every upload in progress (the tray).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const chats = await (await serverApi()).chat.list().catch((e: Error) => e);
  return (
    <SidebarProvider>
      <AppSidebar
        chats={chats instanceof Error ? [] : chats}
        error={chats instanceof Error ? chats.message : undefined}
      />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
      <UploadTray />
    </SidebarProvider>
  );
}
