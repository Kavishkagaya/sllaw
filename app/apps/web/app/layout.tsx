import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Source_Serif_4 } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TRPCReactProvider } from "@/trpc/client";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif" });

export const metadata = { title: "sllaw", description: "Sri Lankan law, answered with citations." };

// Clerk's forms take the theme's CSS variables, so they follow light and dark with the rest of the app.
const appearance = {
  cssLayerName: "clerk",
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorBackground: "var(--card)",
    colorForeground: "var(--foreground)",
    colorMutedForeground: "var(--muted-foreground)",
    colorMuted: "var(--muted)",
    colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)",
    colorBorder: "var(--border)",
    colorRing: "var(--ring)",
    colorNeutral: "var(--foreground)",
    colorDanger: "var(--destructive)",
    fontFamily: "var(--font-sans)",
    borderRadius: "var(--radius)",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ClerkProvider appearance={appearance} signInUrl="/sign-in" signUpUrl="/sign-up">
            <TooltipProvider>
              <TRPCReactProvider>{children}</TRPCReactProvider>
            </TooltipProvider>
          </ClerkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
