import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { loadSidebar } from "@/components/sidebar/load";
import { SidebarInset } from "@/components/ui/sidebar";

// Outside a case: the one sidebar with no case open.
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const s = await loadSidebar();
  return (
    <>
      <AppSidebar {...s} />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
}
