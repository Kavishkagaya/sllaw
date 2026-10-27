import { MainSidebar } from "@/components/sidebar/main-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { serverApi } from "@/trpc/server";

// Outside a case: home, cases, quick chats.
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const api = await serverApi();
  const [cases, chats] = await Promise.all([api.case.list(), api.chat.list()]).catch((e: Error) => [e, e] as const);
  const error = cases instanceof Error ? cases.message : undefined;
  return (
    <>
      <MainSidebar
        cases={cases instanceof Error ? [] : cases}
        chats={chats instanceof Error ? [] : chats}
        error={error}
      />
      <SidebarInset className="h-svh overflow-hidden">{children}</SidebarInset>
    </>
  );
}
