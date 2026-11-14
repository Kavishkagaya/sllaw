import { nextDate } from "@sllaw/office";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { loadSidebar } from "@/components/sidebar/load";
import { SidebarInset } from "@/components/ui/sidebar";
import { fmtDay } from "@/lib/format";
import { orNotFound, serverApi } from "@/trpc/server";

// Inside a case: the one sidebar with this case open in place (its pages and chats).
export default async function CaseLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const api = await serverApi();
  const [c, chats, office, s] = await Promise.all([
    orNotFound(api.case.open({ caseId: id })),
    orNotFound(api.chat.list({ caseId: id })),
    api.office.open({ caseId: id }).catch(() => null),
    loadSidebar(),
  ]);
  const next = office && nextDate(office.office, office.today);
  const line = [office?.office.header.court, next && fmtDay(next.date)].filter(Boolean).join(" · ");
  const files = s.cases.find((x) => x.id === id)?.files ?? 0;
  return (
    <>
      <AppSidebar {...s} open={{ id: c.id, title: c.title, line, files, chats }} />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
}
