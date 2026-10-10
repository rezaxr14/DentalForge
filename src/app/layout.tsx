import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "@/shared/ui/theme-provider";
import { ThemeToggle } from "@/shared/ui/theme-toggle";
import { OrgSwitcher } from "@/shared/ui/org-switcher";
import { SessionHeader } from "@/shared/ui/session-header";
import { WorkerStatusBadge } from "@/features/capability";
import "./globals.css";

export const metadata: Metadata = {
  title: "TraceForge — dental agent trace workbench",
  description:
    "Research prototype: browse agent traces, evals, annotations and data-quality over real Dental-Agent artifacts. Not for clinical use.",
};

const nav = [
  { href: "/traces", label: "Traces" },
  { href: "/evals", label: "Evals" },
  { href: "/labels", label: "Labels" },
  { href: "/tools", label: "Tools" },
  { href: "/quality", label: "Quality" },
  { href: "/rewards", label: "Rewards" },
  { href: "/agent", label: "Agent" },
  { href: "/training", label: "Training" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <header className="border-b border-border">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2">
              <Link href="/" className="font-semibold tracking-tight">
                TraceForge
              </Link>
              <nav aria-label="Modules" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {nav.map((n) => (
                  <Link key={n.href} href={n.href} className="text-zinc-600 hover:text-foreground">
                    {n.label}
                  </Link>
                ))}
              </nav>
              <div className="ms-auto flex items-center gap-3">
                <WorkerStatusBadge />
                <OrgSwitcher />
                <SessionHeader />
                <ThemeToggle inline />
              </div>
            </div>
          </header>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
