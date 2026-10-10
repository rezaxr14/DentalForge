import type { StrategyKind, StrategyResolution } from "../types";

/**
 * Which provenance label a resolved strategy means for a *result* (plan §9.2).
 * `unavailable` has no provenance — there is no result to label.
 */
export const PROVENANCE_BY_STRATEGY: Record<StrategyKind, string | null> = {
  worker: "worker_exact",
  browser: "browser_approx",
  replay: "import_replay",
  heuristic: "heuristic",
  unavailable: null,
};

const TONE: Record<StrategyKind, string> = {
  worker: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  browser: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  replay: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  heuristic: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unavailable: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/**
 * Small provenance chip. Either resolve it from a ladder `resolution`, or pass
 * a literal `provenance` (e.g. read from a stored artifact row). The tooltip
 * carries the reason, so the badge never claims more than was decided.
 */
export function ProvenanceBadge({
  resolution,
  provenance: literal,
  className = "",
}: {
  resolution?: StrategyResolution;
  /** Literal provenance label (stored artifact rows); overrides the resolution. */
  provenance?: string;
  className?: string;
}) {
  const provenance = literal ?? (resolution ? PROVENANCE_BY_STRATEGY[resolution.strategy] : null);
  const strategy = resolution?.strategy ?? "replay";
  return (
    <span
      title={resolution?.reason}
      data-provenance={provenance ?? "unavailable"}
      data-strategy={resolution?.strategy}
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none ${TONE[strategy]} ${className}`}
    >
      {provenance ?? "unavailable"}
    </span>
  );
}
