import Link from "next/link";
import { Suspense } from "react";
import type { EvalCaseT } from "@/shared/contracts/traces";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { Badge, Card, ScoreBar, SectionHeading, Stat } from "@/shared/ui/primitives";
import { PageShell } from "@/shared/ui/page";

// Reads per-request state (the demo org, seeded rows): never freeze it into HTML at build time.
export const dynamic = "force-dynamic";

function ProvenanceBadge({ provenance }: { provenance: string }) {
  return (
    <Badge tone={provenance === "postgres" ? "success" : "warning"}>
      {provenance === "postgres" ? "imported runs" : "fixture replay"}
    </Badge>
  );
}

function modelLabel(model: string) {
  return model
    .replace(/^accounts\//, "")
    .replace(/^models\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function EvalsTable() {
  const { source } = await resolveDataSource();
  const rows = [...(await source.listEvalRuns())].sort((a, b) => b.exactF1 - a.exactF1);
  const maxExact = Math.max(0.0001, ...rows.map((r) => r.exactF1));
  return (
    <Card className="mt-6 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-[11px] tracking-wide text-zinc-500 uppercase">
              <th className="px-4 py-2.5 font-medium">#</th>
              <th className="px-4 py-2.5 font-medium">Model</th>
              <th className="px-4 py-2.5 font-medium">Provider</th>
              <th className="px-4 py-2.5 font-medium">n</th>
              <th className="w-40 px-4 py-2.5 font-medium">Exact F1</th>
              <th className="w-40 px-4 py-2.5 font-medium">FDI F1</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent/60">
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                      i === 0
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                        : "bg-muted text-zinc-600"
                    }`}
                  >
                    {i + 1}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Link href={`/evals/${r.id}`} className="font-medium hover:underline">
                    {modelLabel(r.model)}
                  </Link>
                  <div className="mt-0.5 max-w-[22rem] truncate font-mono text-[10px] text-zinc-500" title={r.model}>
                    {r.model}
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-600">{r.provider}</td>
                <td className="px-4 py-3 font-mono tabular-nums">{r.n}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-muted">
                      <div
                        className="h-full rounded-full bg-sky-500"
                        style={{ width: `${(r.exactF1 / maxExact) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 text-right font-mono text-xs tabular-nums">{r.exactF1.toFixed(3)}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-muted">
                      <div
                        className="h-full rounded-full bg-violet-500"
                        style={{ width: `${(r.fdiF1 / maxExact) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 text-right font-mono text-xs tabular-nums">{r.fdiF1.toFixed(3)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function EvalsPage() {
  const { source, fallbackReason } = await resolveDataSource();
  const runs = await source.listEvalRuns();
  const cases = runs.reduce((n, r) => n + r.n, 0);
  const best = [...runs].sort((a, b) => b.exactF1 - a.exactF1)[0];
  return (
    <PageShell className="py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Eval Hub</h1>
        <ProvenanceBadge provenance={source.provenance} />
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        Zero-shot dental findings from real DENTEX test images. Exact F1 requires the quadrant, tooth
        position and diagnosis to all match; FDI F1 counts a hit when the tooth is identified.
      </p>
      {fallbackReason && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {fallbackReason}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Runs" value={runs.length} hint="zero-shot models" />
        <Stat label="Cases scored" value={cases} hint="DENTEX test split" />
        <Stat
          label="Best exact F1"
          value={best ? best.exactF1.toFixed(3) : "—"}
          hint={best ? modelLabel(best.model) : undefined}
          tone="info"
        />
        <Stat
          label="Best FDI F1"
          value={runs.length ? Math.max(...runs.map((r) => r.fdiF1)).toFixed(3) : "—"}
          tone="success"
        />
      </div>

      <SectionHeading
        className="mt-8"
        title="Leaderboard"
        description={
          source.provenance === "postgres"
            ? "Means over the full imported runs, computed at import time."
            : "Reference means over the full real JSONL files (verified in M0). The fixture holds one drill-down case per model."
        }
      />
      <Suspense fallback={<p className="mt-6 text-sm">Loading leaderboard…</p>}>
        <EvalsTable />
      </Suspense>
      <p className="mt-4 text-xs text-zinc-500">
        Click a model for per-case metrics and calibration. SFT and GRPO have not been run yet, so they
        are absent from this table.
      </p>
    </PageShell>
  );
}

/** Per-case drill-down (kept for the legacy `/evals/[id]` shape). */
export function EvalDetail({ evalCase: c }: { evalCase: EvalCaseT }) {
  return (
    <div className="mt-6 space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Exact F1" value={c.exact_f1.toFixed(3)} />
        <Stat label="FDI F1" value={c.fdi_f1.toFixed(3)} />
        <Stat label="Closeness" value={c.closeness_score.toFixed(3)} />
        <Stat label="Format" value={c.format_ok ? "ok" : "bad"} tone={c.format_ok ? "success" : "warning"} />
      </div>
      <Card className="p-4">
        <p className="font-medium">Matched pairs ({c.matched_pairs.length})</p>
        <ul className="mt-2 space-y-1">
          {c.matched_pairs.slice(0, 10).map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded bg-muted/60 px-2 py-1 text-xs">
              <span className="font-mono">
                GT Q{p.gt.quadrant}T{p.gt.tooth_position} {p.gt.diagnosis}
              </span>
              <span className="text-zinc-400">→</span>
              <span className="font-mono">
                pred Q{p.pred.quadrant}T{p.pred.tooth_position} {p.pred.diagnosis}
              </span>
              <Badge tone={p.fdi_match ? "success" : "danger"}>fdi {String(p.fdi_match)}</Badge>
              <Badge tone={p.exact_match ? "success" : "neutral"}>exact {String(p.exact_match)}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function EvalDetailSection({ evalCase: c }: { evalCase: EvalCaseT }) {
  return (
    <Suspense fallback={<p className="mt-6 text-sm">Loading case…</p>}>
      <EvalDetail evalCase={c} />
    </Suspense>
  );
}

export function EvalMetricsStrip({
  summary,
  n,
}: {
  summary: Record<string, number>;
  n: number;
}) {
  const exact = summary.exact_f1 ?? 0;
  const fdi = summary.fdi_f1 ?? 0;
  const closeness = summary.closeness ?? summary.closeness_score ?? 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Cases" value={n} />
      <Card className="p-4">
        <ScoreBar label="Exact F1" value={exact} tone="sky" />
      </Card>
      <Card className="p-4">
        <ScoreBar label="FDI F1" value={fdi} tone="violet" />
      </Card>
      <Card className="p-4">
        <ScoreBar label="Closeness" value={closeness} tone="emerald" />
      </Card>
    </div>
  );
}
