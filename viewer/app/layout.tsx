import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SL Law Viewer",
  description: "Sri Lanka legal document viewer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full flex flex-col bg-gray-50 antialiased">
        <header className="shrink-0 bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3">
          <Link href="/" className="font-semibold text-gray-900 hover:text-blue-600 transition-colors">
            SL Law
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm text-gray-500">Document Viewer</span>
        </header>
        <div className="flex-1 min-h-0">{children}</div>
      </body>
    </html>
  );
}
