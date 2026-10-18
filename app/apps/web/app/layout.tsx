import { ClerkProvider } from "@clerk/nextjs";
import { TRPCReactProvider } from "../trpc/client";
import "./globals.css";

export const metadata = { title: "sllaw" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <TRPCReactProvider>{children}</TRPCReactProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
