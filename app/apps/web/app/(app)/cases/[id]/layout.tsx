import { CaseSidebar } from "@/components/sidebar/case-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { orNotFound, serverApi } from "@/trpc/server";

// Inside a case: the case's own sidebar (its pages and chats) beside every page under /cases/<id>.
export default async function CaseLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = await serverApi();
  const [c, chats, cases] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.chat.list({ caseId: id })),
    api.case.list(),
  ]);
  return (
    <>
      <CaseSidebar current={{ id: c.id, title: c.title }} cases={cases} chats={chats} />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
}
