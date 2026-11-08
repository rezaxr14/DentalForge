import Link from "next/link";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { PageShell } from "@/shared/ui/page";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import { Badge, Card, EmptyState, ScoreBar, Stat } from "@/shared/ui/primitives";

type Model = {
  name: string;
  kind: string;
  stage: string;
  hfPath: string | null;
  meta: Record<string, unknown>;
};
type TrainingRun = { kind: string; name: string; status: string };

const STAGE_TONE: Record<string, "neutral" | "info" | "violet" | "success" | "warning"> = {
  zero_shot: "info",
  sft: "violet",
  grpo: "violet",
  yolo: "success",
  test: "warning",
};

function PipelineStep({
  index,
  name,
  status,
  detail,
  last,
}: {
  index: number;
  name: string;
  status: string;
  detail: string;
  last?: boolean;
}) {
  const done = status === "Done";
  return (
    <li className="relative flex-1">
      <Card className="h-full p-4">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
              done
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            }`}
          >
            {index}
          </span>
          <Badge tone={done ? "success" : "warning"}>{status}</Badge>
        </div>
        <div className="mt-3 text-sm font-semibold">{name}</div>
        <div className="mt-1 text-xs text-zinc-600">{detail}</div>
      </Card>
      {!last && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -right-2 hidden h-px w-4 bg-border lg:block"
        />
      )}
    </li>
  );
}

export default async function TrainingPage() {
  const { source, fallbackReason } = await resolveDataSource();
  const traces = await source.listTraces();
  const evals = await source.listEvalRuns();

  let models: Model[] = [];
  let trainingRuns: TrainingRun[] = [];
  try {
    const slug = process.env.DEMO_ORG_SLUG ?? process.env.IMPORT_ORG_SLUG ?? "demo";
    const env = getEnv();
    if (env.DATABASE_URL) {
      const store = new DrizzleOrgStore(getPgDb());
      const org = await store.getOrgBySlug(slug);
      if (org) {
        const scoped = store.scoped(org.id);
        models = (await scoped.listModels()).map((m) => ({
          name: m.name,
          kind: m.kind,
          stage: m.stage,
          hfPath: m.hfPath,
          meta: m.meta,
        }));
        trainingRuns = (await scoped.listTrainingRuns()).map((r) => ({
          kind: r.kind,
          name: r.name,
          status: r.status,
        }));
      }
    }
  } catch {
    // graceful degradation: the page still renders the honest empty states
  }

  const sftDone = trainingRuns.some((r) => r.kind === "sft" && r.status === "succeeded");
  const grpoDone = trainingRuns.some((r) => r.kind === "grpo" && r.status === "succeeded");
  const bestZeroShot = [...evals].sort((a, b) => b.exactF1 - a.exactF1)[0];
  const yolo = models.find((m) => m.kind === "yolo");
  const yoloMetrics = (yolo?.meta?.metrics ?? {}) as Record<string, number>;

  const pipeline = [
    { name: "Data", status: traces.length > 0 ? "Done" : "Not run yet", detail: `${traces.length} traces · ${evals.length} eval runs` },
    {
      name: "SFT",
      status: sftDone ? "Done" : "Not run yet",
      detail: sftDone ? `${trainingRuns.filter((r) => r.kind === "sft").length} run(s) recorded` : "No SFT run recorded",
    },
    {
      name: "GRPO",
      status: grpoDone ? "Done" : "Not run yet",
      detail: grpoDone ? `${trainingRuns.filter((r) => r.kind === "grpo").length} run(s) recorded` : "No GRPO run recorded",
    },
    { name: "Evaluation", status: evals.length > 0 ? "Done" : "Not run yet", detail: `${evals.length} zero-shot runs` },
  ];

  return (
    <PageShell className="py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Training Hub</h1>
        <Badge tone="warning">SFT and GRPO not run yet</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        The pipeline, checkpoint matrix and reward definitions. A stage is marked done only when real
        records exist in the database; there are no target numbers in any cell.
      </p>
      {fallbackReason && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {fallbackReason}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Traces" value={traces.length} hint="recorded trajectories" />
        <Stat label="Eval runs" value={evals.length} hint="zero-shot" tone="info" />
        <Stat label="Models registered" value={models.length} hint="registry rows" />
        <Stat label="Training runs" value={trainingRuns.length} hint="SFT / GRPO / YOLO" tone={trainingRuns.length ? "success" : "warning"} />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Pipeline</h2>
        <ol className="mt-3 grid gap-3 lg:grid-cols-4">
          {pipeline.map((p, i) => (
            <PipelineStep key={p.name} index={i + 1} {...p} last={i === pipeline.length - 1} />
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Experiment matrix</h2>
        <p className="mt-1 text-xs text-zinc-600">
          Rows are training stages; columns are the tool setting. Only base zero-shot has recorded numbers.
        </p>
        <Card className="mt-3 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-[11px] tracking-wide text-zinc-500 uppercase">
                  <th className="px-4 py-2.5 font-medium">Stage</th>
                  <th className="px-4 py-2.5 font-medium">With tools</th>
                  <th className="px-4 py-2.5 font-medium">No tools</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-4 py-3 font-medium">Base (zero-shot)</td>
                  <td className="px-4 py-3">
                    {bestZeroShot ? (
                      <div className="flex items-center gap-3">
                        <span className="font-mono tabular-nums">{bestZeroShot.exactF1.toFixed(3)}</span>
                        <span className="text-xs text-zinc-500">exact F1 · {bestZeroShot.model}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-500">no run</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">not available</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-4 py-3 font-medium">SFT</td>
                  <td className="px-4 py-3">
                    <Badge tone="warning">Not run yet</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone="warning">Not run yet</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium">GRPO</td>
                  <td className="px-4 py-3">
                    <Badge tone="warning">Not run yet</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone="warning">Not run yet</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Model registry</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Registered by the importer and workers. Test backends are not the research model.
          </p>
          {models.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No models registered">Seed the demo bundle or attach a worker to populate this table.</EmptyState>
            </div>
          ) : (
            <Card className="mt-3 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-left text-[11px] tracking-wide text-zinc-500 uppercase">
                      <th className="px-4 py-2.5 font-medium">Model</th>
                      <th className="px-4 py-2.5 font-medium">Stage</th>
                      <th className="px-4 py-2.5 font-medium">Kind</th>
                      <th className="px-4 py-2.5 font-medium">Metrics</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m, i) => {
                      const metrics = (m.meta?.metrics ?? {}) as Record<string, number>;
                      const metricText = Object.entries(metrics)
                        .filter(([, v]) => typeof v === "number")
                        .slice(0, 2)
                        .map(([k, v]) => `${k} ${Number(v).toFixed(3)}`)
                        .join(" · ");
                      return (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="max-w-[18rem] px-4 py-2.5">
                            <div className="truncate font-medium" title={m.name}>
                              {m.name}
                            </div>
                            {typeof m.meta?.backend === "string" && (
                              <div className="font-mono text-[10px] text-zinc-500">{m.meta.backend}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge tone={STAGE_TONE[m.stage] ?? "neutral"}>{m.stage}</Badge>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs">{m.kind}</td>
                          <td className="px-4 py-2.5 text-xs text-zinc-600">{metricText || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Reward components</h2>
            <p className="mt-1 text-xs text-zinc-600">GRPO reward definition used by the recorded reward inspector.</p>
            <ul className="mt-3 space-y-2 text-xs">
              <li className="flex justify-between gap-2">
                <span>accuracy</span>
                <span className="font-mono">1.0</span>
              </li>
              <li className="flex justify-between gap-2">
                <span>format</span>
                <span className="font-mono">0.2</span>
              </li>
              <li className="flex justify-between gap-2">
                <span>toolValidity</span>
                <span className="font-mono">0.2</span>
              </li>
              <li className="flex justify-between gap-2">
                <span>efficiency</span>
                <span className="font-mono">0.1</span>
              </li>
            </ul>
            <p className="mt-3 text-[11px] text-zinc-500">Efficiency reference budget: 6 calls per distinct located tooth.</p>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Grounding checkpoint</h2>
            {yolo ? (
              <>
                <p className="mt-1 text-xs text-zinc-600">{yolo.name}</p>
                <div className="mt-3 space-y-2">
                  {Object.entries(yoloMetrics).length > 0 ? (
                    Object.entries(yoloMetrics)
                      .filter(([, v]) => typeof v === "number")
                      .slice(0, 4)
                      .map(([k, v]) => <ScoreBar key={k} label={k} value={Number(v)} tone="emerald" />)
                  ) : (
                    <p className="text-xs text-zinc-500">No metrics recorded in the registry row.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">No grounding checkpoint registered.</p>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">What is honest here</h2>
            <ul className="mt-2 space-y-1.5 text-xs text-zinc-600">
              <li>SFT and GRPO cells stay “Not run yet” until a run succeeds.</li>
              <li>No target or expected numbers are shown in any cell.</li>
              <li>Zero-shot numbers come from the recorded eval runs.</li>
            </ul>
            <Link href="/evals" className="mt-3 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
              Open the eval leaderboard →
            </Link>
          </Card>
        </div>
      </section>
    </PageShell>
  );
}
