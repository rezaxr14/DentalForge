import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared page frame. Every page used to declare its own `<main className="mx-auto max-w-5xl …">`; inside the
 * root layout's flex column an auto-margin child shrinks to its content, so each page got a different width and
 * left edge (and none lined up with the header). `w-full` fixes the shrink; one set of sizes fixes the rest.
 */
const SIZES = {
  default: "max-w-6xl", // same container as the header, so the left edges line up
  reading: "max-w-3xl",
  form: "max-w-2xl",
  narrow: "max-w-md",
} as const;

const DEFAULT_PADDING: Record<keyof typeof SIZES, string> = {
  default: "py-8",
  reading: "py-8",
  form: "py-12",
  narrow: "py-16",
};

export function PageShell({
  size = "default",
  className,
  children,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  children: ReactNode;
}) {
  return <main className={`mx-auto w-full ${SIZES[size]} px-6 ${className ?? DEFAULT_PADDING[size]}`}>{children}</main>;
}

/** "← Back to X" on its own row above the page title (never inline with other elements). */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group mb-3 -ms-1 flex w-fit items-center gap-1 rounded px-1 py-0.5 text-sm text-zinc-600 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="transition-transform group-hover:-translate-x-0.5"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
      {children}
    </Link>
  );
}

/** The research-use notice, shown once by the root layout on every page. */
export function PrototypeBanner() {
  return (
    <div
      role="note"
      className="border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="mx-auto max-w-6xl px-6 py-1 text-xs font-medium">Research prototype, not for clinical use</p>
    </div>
  );
}
