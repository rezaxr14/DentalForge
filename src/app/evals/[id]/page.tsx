import { resolveDataSource } from "@/shared/lib/resolve-source";
import { BackLink, PageShell } from "@/shared/ui/page";
import { Badge, Card, EmptyState, ScoreBar, Stat } from "@/shared/ui/primitives";
import { EvalDetailSection, EvalMetricsStrip } from "../page";

function modelLabel(model: string) {
  return model
    .replace(/^accounts\//, "")
    .replace(/^models\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Confidence vs FDI F1. Points are real cases; no fitted line is implied. */
function Calibration({ points }: { points: { confidence: number; fdi: number; exact: number }[] }) {
  const W = 520;
  const H = 220;
  const pad = 34;
  const x = (v: number) => pad + v * (W - pad * 2);
  const y = (v: number) => H - pad - v * (H - pad * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Confidence versus FDI F1 per case">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={pad} y2={H - pad} className="stroke-border" strokeWidth="1" />
          <line x1={pad} x2={W - pad} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth="1" />
          <text x={x(t)} y={H - pad + 14} textAnchor="middle" className="fill-zinc-500 text-[9px]">
            {t.toFixed(2)}
          </text>
          <text x={pad - 6} y={y(t) + 3} textAnchor="end" className="fill-zinc-500 text-[9px]">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(Math.max(0, Math.min(1, p.confidence)))}
          cy={y(Math.max(0, Math.min(1, p.fdi)))}
          r={p.exact >= 0.999 ? 4 : 3}
          className={p.exact >= 0.999 ? "fill-emerald-500" : "fill-sky-500"}
          fillOpacity="0.75"
        />
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" className="fill-zinc-500 text-[10px]">
        reported confidence
      </text>
      <text x={10} y={H / 2} textAnchor="middle" transform={`rotate(-90 10 ${H / 2})`} className="fill-zinc-500 text-[10px]">
        FDI F1
      </text>
    </svg>
  );
}

export default async function EvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { source } = await resolveDataSource();
  const run = await source.getEvalRun(id);
  const legacy = run ? null : await source.getEvalCase(id);

  if (!run && legacy) {
    return (
      <PageShell>
        <BackLink href="/evals">Leaderboard</BackLink>
        <h1 className="text-2xl font-semibold tracking-tight">Eval case {id}</h1>
        <EvalDetailSection evalCase={legacy.evalCase} />
      </PageShell>
    );
  }

  if (!run) {
    return (
      <PageShell>
        <BackLink href="/evals">Leaderboard</BackLink>
        <h1 className="text-2xl font-semibold tracking-tight">Eval run not found</h1>
        <p className="mt-2 text-sm text-zinc-600">This run is not in the {source.provenance} source.</p>
      </PageShell>
    );
  }

  const points = run.cases
    .filter((c) => typeof c.confidence === "number")
    .map((c) => ({ confidence: c.confidence as number, fdi: c.fdi_f1, exact: c.exact_f1 }));
  const exactCorrect = run.cases.filter((c) => c.exact_match).length;
  const formatOk = run.cases.filter((c) => c.format_ok).length;

  return (
    <PageShell className="py-10">
      <BackLink href="/evals">Leaderboard</BackLink>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{modelLabel(run.model)}</h1>
        <Badge tone="info">{run.provider}</Badge>
        <Badge tone={run.provenance === "postgres" ? "success" : "warning"}>
          {run.provenance === "postgres" ? "imported run" : "fixture replay"}
        </Badge>
      </div>
      <p className="mt-1 font-mono text-xs text-zinc-500">{run.model}</p>

      <div className="mt-6">
        <EvalMetricsStrip summary={run.summary} n={run.n} />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Dataset" value={run.dataset.toUpperCase()} hint={`${run.split} split`} />
        <Stat label="Exact matches" value={exactCorrect} hint={`of ${run.cases.length} loaded cases`} tone="success" />
        <Stat label="Format pass" value={`${run.cases.length ? Math.round((formatOk / run.cases.length) * 100) : 0}%`} />
        <Stat label="Cases loaded" value={run.cases.length} hint={`run reports n=${run.n}`} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Calibration</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Each point is a scored case: reported confidence against FDI F1. Green points are exact matches.
          </p>
          {points.length > 0 ? (
            <div className="mt-3">
              <Calibration points={points} />
            </div>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-6 text-center text-xs text-zinc-500">
              No case in this run carries a numeric confidence.
            </p>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold">Score breakdown</h2>
          <div className="mt-3 space-y-3">
            <ScoreBar label="Exact F1" value={run.summary.exact_f1 ?? 0} tone="sky" />
            <ScoreBar label="FDI F1" value={run.summary.fdi_f1 ?? 0} tone="violet" />
            <ScoreBar
              label="Closeness"
              value={run.summary.closeness ?? run.summary.closeness_score ?? 0}
              tone="emerald"
            />
            <ScoreBar label="Format OK" value={run.n ? formatOk / run.cases.length : 0} tone="amber" />
          </div>
          {run.cases.length < run.n && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
              {run.n - run.cases.length} cases are summarised in the run mean but not loaded as rows
              {run.provenance === "fixture" ? " (the fixture ships one drill-down case)." : "."}
            </p>
          )}
        </Card>
      </div>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">Cases</h2>
      {run.cases.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No case rows for this run">
            The run summary is available, but the individual cases were not stored.
          </EmptyState>
        </div>
      ) : (
        <Card className="mt-3 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-[11px] tracking-wide text-zinc-500 uppercase">
                  <th className="px-4 py-2.5 font-medium">Case</th>
                  <th className="px-4 py-2.5 font-medium">GT</th>
                  <th className="px-4 py-2.5 font-medium">Pred</th>
                  <th className="px-4 py-2.5 font-medium">Exact F1</th>
                  <th className="px-4 py-2.5 font-medium">FDI F1</th>
                  <th className="px-4 py-2.5 font-medium">Confidence</th>
                  <th className="px-4 py-2.5 font-medium">Format</th>
                </tr>
              </thead>
              <tbody>
                {run.cases.map((c, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-accent/60">
                    <td className="px-4 py-2.5 font-mono">{c.image_id || i + 1}</td>
                    <td className="px-4 py-2.5 tabular-nums">{c.ground_truth.length}</td>
                    <td className="px-4 py-2.5 tabular-nums">{c.predictions.length}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">{c.exact_f1.toFixed(3)}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">{c.fdi_f1.toFixed(3)}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">
                      {typeof c.confidence === "number" ? c.confidence.toFixed(3) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={c.format_ok ? "success" : "danger"}>{c.format_ok ? "ok" : "bad"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </PageShell>
  );
}
