import Link from "next/link";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { PageShell } from "@/shared/ui/page";
import { Badge, Card, CardLink, Stat } from "@/shared/ui/primitives";
import { TraceRowLink } from "@/shared/ui/trace-card";

const modules = [
  {
    href: "/traces",
    name: "Trace Explorer",
    desc: "Browse recorded multi-turn dental-agent trajectories with radiograph overlays, tool renders and verifier outcomes.",
    tag: "recorded data",
    tone: "info" as const,
  },
  {
    href: "/evals",
    name: "Eval Hub",
    desc: "Zero-shot leaderboard with exact/FDI F1, per-case calibration and real DENTEX test predictions.",
    tag: "8 runs · 395 cases",
    tone: "violet" as const,
  },
  {
    href: "/labels",
    name: "LabelForge",
    desc: "Box annotation with FDI numbering and pathology, review workflow and dataset export.",
    tag: "annotation",
    tone: "success" as const,
  },
  {
    href: "/tools",
    name: "Tool Lab",
    desc: "Run the grounding tools on a radiograph and inspect crops, contrast and detection output.",
    tag: "8 tools",
    tone: "warning" as const,
  },
  {
    href: "/quality",
    name: "Data Quality",
    desc: "Verifier rejections, directive leaks and false positives across the imported corpora.",
    tag: "audit",
    tone: "neutral" as const,
  },
  {
    href: "/rewards",
    name: "Reward Inspector",
    desc: "GRPO reward components per trajectory: accuracy, format, tool validity and efficiency.",
    tag: "GRPO",
    tone: "neutral" as const,
  },
  {
    href: "/agent",
    name: "Live Agent",
    desc: "Stream a live worker run when one is attached, or replay a recorded run step by step.",
    tag: "live + replay",
    tone: "info" as const,
  },
  {
    href: "/training",
    name: "Training Hub",
    desc: "The SFT → GRPO pipeline, checkpoint matrix and honest not-run-yet states.",
    tag: "pipeline",
    tone: "violet" as const,
  },
];

const ICONS: Record<string, string> = {
  "/traces": "M4 6h16M4 12h16M4 18h10",
  "/evals": "M4 19V5m0 14h16M8 15l3-4 3 2 4-6",
  "/labels": "M4 4h16v16H4zM8 8h8v8H8z",
  "/tools": "M14 6l4 4-8 8H6v-4zM14 6l4 4",
  "/quality": "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  "/rewards": "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.2l5.9-.9z",
  "/agent": "M12 3v3m-7 4h14v10H5zM9 14h.01M15 14h.01",
  "/training": "M4 19h16M6 19V9m4 10V5m4 14v-7m4 7V8",
};

function modelLabel(model: string) {
  return model
    .replace(/^accounts\//, "")
    .replace(/^models\//, "")
    .replace(/[-_/]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function ModuleIcon({ href }: { href: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[href] ?? "M4 4h16v16H4z"} />
    </svg>
  );
}

export default async function Home() {
  const { source } = await resolveDataSource();
  const [traces, evals] = await Promise.all([source.listTraces(), source.listEvalRuns()]);
  const withTools = traces.filter((t) => t.mode === "with_tools").length;
  const totalTurns = traces.reduce((n, t) => n + t.nTurns, 0);
  const totalToolCalls = traces.reduce((n, t) => n + t.nToolCalls, 0);
  const evalCases = evals.reduce((n, r) => n + r.n, 0);
  const best = [...evals].sort((a, b) => b.exactF1 - a.exactF1)[0];
  const recent = [...traces]
    .sort((a, b) => Number(b.mode === "with_tools") - Number(a.mode === "with_tools") || b.nFindings - a.nFindings)
    .slice(0, 6);

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_80%_0%,rgba(14,165,233,0.14),transparent_60%),radial-gradient(50%_70%_at_0%_100%,rgba(139,92,246,0.12),transparent_60%)]"
        />
        <PageShell className="relative py-14 lg:py-20">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">Dental agent research</Badge>
                <Badge tone="success">
                  {source.provenance === "postgres" ? "live imported data" : "fixture replay"}
                </Badge>
                <Badge tone="warning">not for clinical use</Badge>
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                TraceForge
                <span className="mt-2 block bg-gradient-to-r from-sky-600 via-violet-600 to-emerald-600 bg-clip-text text-transparent dark:from-sky-400 dark:via-violet-400 dark:to-emerald-400">
                  a workbench for dental-agent traces
                </span>
              </h1>
              <p className="mt-5 max-w-2xl text-base text-zinc-600">
                Real DENTEX radiographs, recorded multi-turn tool use, zero-shot evaluations and
                annotation tooling in one place. Every number on this site is computed from the data
                behind it — no screenshots standing in for results.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  href="/traces"
                  className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                >
                  Explore traces
                </Link>
                <Link
                  href="/evals"
                  className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                >
                  See the leaderboard
                </Link>
                <Link
                  href="/about-data"
                  className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:text-foreground"
                >
                  Data &amp; licences →
                </Link>
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-sky-500/10 via-violet-500/10 to-emerald-500/10 blur-2xl" aria-hidden="true" />
              <Card className="relative overflow-hidden">
                <div className="relative aspect-[16/9] bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/labels/1.jpg"
                    alt="DENTEX panoramic radiograph used by the demo"
                    className="h-full w-full object-cover opacity-95"
                  />
                  <svg viewBox="0 0 2744 1316" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
                    <rect x="542" y="698" width="220" height="271" fill="rgba(16,185,129,0.10)" stroke="#10b981" strokeWidth="8" strokeDasharray="28 18" />
                    <rect x="2044" y="841" width="184" height="258" fill="rgba(245,158,11,0.10)" stroke="#f59e0b" strokeWidth="8" />
                  </svg>
                  <div className="absolute top-3 left-3 flex gap-1.5">
                    <Badge tone="success">ground truth</Badge>
                    <Badge tone="warning">prediction</Badge>
                  </div>
                </div>
                <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
                  <div className="px-4 py-3">
                    <div className="text-[10px] tracking-wide text-zinc-500 uppercase">Traces</div>
                    <div className="text-lg font-semibold tabular-nums">{traces.length}</div>
                  </div>
                  <div className="px-4 py-3">
                    <div className="text-[10px] tracking-wide text-zinc-500 uppercase">Tool calls</div>
                    <div className="text-lg font-semibold tabular-nums">{totalToolCalls}</div>
                  </div>
                  <div className="px-4 py-3">
                    <div className="text-[10px] tracking-wide text-zinc-500 uppercase">Eval cases</div>
                    <div className="text-lg font-semibold tabular-nums">{evalCases}</div>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Recorded traces" value={traces.length} hint={`${withTools} with tools`} />
            <Stat label="Turns replayed" value={totalTurns} hint="multi-turn trajectories" />
            <Stat label="Eval runs" value={evals.length} hint={`${evalCases} scored cases`} tone="info" />
            <Stat
              label="Best exact F1"
              value={best ? best.exactF1.toFixed(3) : "—"}
              hint={best ? "zero-shot DENTEX test" : undefined}
              tone="success"
            />
          </div>
        </PageShell>
      </section>

      <PageShell className="py-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">What is inside</h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              Eight connected surfaces over one real dataset. Flags and placeholders are honest: a stage
              says “not run yet” until records exist.
            </p>
          </div>
          <Badge tone="neutral">{modules.length} modules</Badge>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {modules.map((m) => (
            <CardLink key={m.href} href={m.href} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <span className="rounded-lg bg-muted p-2 text-zinc-700 dark:text-zinc-300">
                  <ModuleIcon href={m.href} />
                </span>
                <Badge tone={m.tone}>{m.tag}</Badge>
              </div>
              <div className="mt-3 font-medium">{m.name}</div>
              <div className="mt-1 text-sm text-zinc-600">{m.desc}</div>
              <div className="mt-3 text-xs font-medium text-sky-700 transition-transform group-hover:translate-x-0.5 dark:text-sky-400">
                Open →
              </div>
            </CardLink>
          ))}
        </div>
      </PageShell>

      <section className="border-y border-border bg-muted/30">
        <PageShell className="py-12">
          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Recent traces</h2>
                  <p className="mt-1 text-sm text-zinc-600">Recorded trajectories with the richest tool use.</p>
                </div>
                <Link href="/traces" className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
                  All traces →
                </Link>
              </div>
              <div className="mt-4 space-y-2">
                {recent.map((t) => (
                  <TraceRowLink key={t.id} row={t} />
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Zero-shot leaderboard</h2>
                  <p className="mt-1 text-sm text-zinc-600">Exact F1 on DENTEX test images.</p>
                </div>
                <Link href="/evals" className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
                  Full leaderboard →
                </Link>
              </div>
              <div className="mt-4 space-y-2">
                {[...evals]
                  .sort((a, b) => b.exactF1 - a.exactF1)
                  .slice(0, 5)
                  .map((r, i) => (
                    <Link
                      key={r.id}
                      href={`/evals/${r.id}`}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{modelLabel(r.model)}</span>
                      <span className="font-mono text-xs tabular-nums text-zinc-500">n={r.n}</span>
                      <span className="font-mono text-sm font-semibold tabular-nums">{r.exactF1.toFixed(3)}</span>
                    </Link>
                  ))}
              </div>

              <Card className="mt-4 p-4">
                <div className="flex items-center gap-2">
                  <Badge tone="warning">honest status</Badge>
                  <span className="text-sm font-medium">SFT and GRPO have not been run yet</span>
                </div>
                <p className="mt-2 text-xs text-zinc-600">
                  The Training Hub shows the pipeline and the empty states instead of invented metrics.
                  Only zero-shot runs and the DENTEX-only grounding checkpoint exist today.
                </p>
                <Link href="/training" className="mt-2 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
                  Open the Training Hub →
                </Link>
              </Card>
            </div>
          </div>
        </PageShell>
      </section>

      <PageShell className="py-12">
        <Card className="overflow-hidden">
          <div className="grid gap-6 p-6 sm:grid-cols-3">
            <div>
              <h2 className="text-sm font-semibold">Data provenance</h2>
              <p className="mt-2 text-xs text-zinc-600">
                Radiographs, annotations, traces and evaluations are derived from DENTEX (CC BY-NC-SA 4.0).
                Tufts data is never included. Public assets are downscaled derivatives.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold">What is real</h2>
              <p className="mt-2 text-xs text-zinc-600">
                Trace turns, tool calls, verifier outcomes and eval metrics come from recorded files.
                The grounding YOLO checkpoint family was trained on DENTEX only.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Licences &amp; citation</h2>
              <p className="mt-2 text-xs text-zinc-600">
                DENTEX: Hamamci et al., arXiv:2305.19112 (MICCAI 2023). YOLO weights: Ultralytics AGPL-3.0.
              </p>
              <Link href="/about-data" className="mt-2 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
                Read the full notice →
              </Link>
            </div>
          </div>
        </Card>
      </PageShell>
    </>
  );
}
