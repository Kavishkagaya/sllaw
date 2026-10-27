import { SidebarProvider } from "@/components/ui/sidebar";
import { UploadTray } from "@/components/upload-tray";

// The signed-in shell: the sidebar's open state and every upload in progress (the tray). Which sidebar shows is the
// nested layout's: the main one ((main)/layout.tsx) or, inside a case, the case's (cases/[id]/layout.tsx).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      {children}
      <UploadTray />
    </SidebarProvider>
  );
}
