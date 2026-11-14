import { ClerkProvider } from "@clerk/nextjs";
import { Geist_Mono, Instrument_Sans, Source_Serif_4 } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TRPCReactProvider } from "@/trpc/client";
import "./globals.css";

// Instrument Sans for the interface, Source Serif 4 for statute text only (font-law), Geist Mono for small labels.
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: { default: "Neethi · Your AI colleague for Sri Lankan law", template: "%s · Neethi" },
  description: "Neethi answers from the Constitution and Acts of Sri Lanka as they stand, cited to the section.",
  applicationName: "Neethi",
};

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
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ClerkProvider
            appearance={appearance}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/dashboard"
            afterSignOutUrl="/"
          >
            <TooltipProvider>
              <TRPCReactProvider>{children}</TRPCReactProvider>
            </TooltipProvider>
          </ClerkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
