import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "@/shared/ui/theme-provider";
import { ThemeToggle } from "@/shared/ui/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "TraceForge — dental agent trace workbench",
  description:
    "Research prototype: browse agent traces, evals, annotations and data-quality over real Dental-Agent artifacts. Not for clinical use.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <ThemeToggle />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
