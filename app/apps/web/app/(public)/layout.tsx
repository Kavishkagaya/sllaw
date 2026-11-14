import { auth } from "@clerk/nextjs/server";
import { SiteFooter, SiteHeader } from "@/components/public/site";

// The public site: open without a session (proxy.ts); a signed-in visitor gets "Open Neethi" in the header.
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  return (
    <div className="min-h-svh bg-background text-foreground">
      <SiteHeader signedIn={!!userId} />
      {children}
      <SiteFooter />
    </div>
  );
}
