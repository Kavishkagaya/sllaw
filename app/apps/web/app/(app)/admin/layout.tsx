import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { orNotFound, serverApi } from "@/trpc/server";

// The platform admin side (users.is_admin). To anyone else every page here is the 404 page: the check is the api's
// (superAdmin answers NOT_FOUND), and each page's own calls are checked again.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await orNotFound((await serverApi()).admin.check());
  return (
    <>
      <AdminSidebar />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
}
