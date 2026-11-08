import Link from "next/link";
import type { ReactNode } from "react";

/** Small status pill. Tones are token-based so light/dark both stay readable. */
const TONES = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-muted dark:text-zinc-300",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  warning: "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  danger: "bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
  info: "bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900",
  violet: "bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

/** Surface card. `as` keeps semantics (section/article) without extra wrappers. */
export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag
      className={`rounded-xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className ?? ""}`}
    >
      {children}
    </Tag>
  );
}

export function CardLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group block rounded-xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] dark:hover:border-zinc-600 ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "warning" | "info";
}) {
  const valueTone =
    tone === "success"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : tone === "info"
          ? "text-sky-700 dark:text-sky-400"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${valueTone}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className ?? ""}`}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Horizontal 0..1 meter, used for metrics and score breakdowns. */
export function ScoreBar({
  value,
  label,
  tone = "sky",
}: {
  value: number;
  label: string;
  tone?: "sky" | "emerald" | "amber" | "violet";
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  const fill = {
    sky: "bg-sky-500",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    violet: "bg-violet-500",
  }[tone];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-zinc-600">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{(value ?? 0).toFixed(3)}</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-muted"
        role="img"
        aria-label={`${label}: ${(value ?? 0).toFixed(3)}`}
      >
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-zinc-600">{children}</div>}
    </div>
  );
}

/** Human-friendly DENTEX case label: "DENTEX case 255". */
export function caseName(dataset: string, imageId: number): string {
  const ds = dataset.toLowerCase() === "dentex" ? "DENTEX" : dataset.toUpperCase();
  return `${ds} case ${imageId}`;
}
