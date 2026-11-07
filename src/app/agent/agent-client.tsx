"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useJobStream } from "@/features/jobs";
import { Badge, Card, caseName } from "@/shared/ui/primitives";
import { Radiograph, type OverlayBox } from "@/shared/ui/radiograph";

export type TraceMode = "with_tools" | "no_tools";

export interface ReplayFinding {
  quadrant: number;
  toothPosition: number;
  diagnosis: string;
  confidence: number | null;
  bbox: [number, number, number, number] | null;
}

export interface ReplayToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  isImageOutput: boolean;
  imageUrl: string | null;
  imageProvenance: string | null;
}

export interface ReplayTurn {
  turn: number;
  status: string | null;
  thought: string | null;
  rawOutput: string | null;
  findings: ReplayFinding[];
  toolCalls: ReplayToolCall[];
}

export interface ReplayData {
  id: string;
  dataset: string;
  imageId: number;
  mode: TraceMode;
  cohort: string;
  verified: boolean;
  provenance: string;
  nTurns: number;
  nToolCalls: number;
  formatOk: boolean;
  verifierReason: string | null;
  image: { url: string; width: number; height: number } | null;
  gtBoxes: OverlayBox[];
  finalPredBoxes: OverlayBox[];
  diagnoses: string[];
  turns: ReplayTurn[];
}

export interface TraceOption {
  id: string;
  dataset: string;
  imageId: number;
  mode: TraceMode;
  nTurns: number;
  nToolCalls: number;
  nFindings: number;
  formatOk: boolean;
  verified: boolean;
  imageUrl: string | null;
}

export interface CompareSummary {
  id: string;
  mode: TraceMode;
  nTurns: number;
  nToolCalls: number;
  nFindings: number;
  formatOk: boolean;
  verified: boolean;
}

export interface WorkerInfo {
  mode: "off" | "mock" | "live";
  status: "online" | "degraded" | "offline";
  reason: string | null;
  workers: {
    name: string;
    runtime: string;
    status: "online" | "degraded" | "offline";
    lastHeartbeatAt: string | null;
    capabilities: string[];
  }[];
}

export interface AgentResolution {
  strategy: string;
  reason: string;
  queueable: boolean;
}

function conditionTone(diagnosis: string) {
  const d = diagnosis.toLowerCase();
  if (d.includes("healthy") || d.includes("no finding")) return "success" as const;
  if (d.includes("caries")) return "warning" as const;
  return "info" as const;
}

function modeBadge(mode: TraceMode) {
  return (
    <Badge tone={mode === "with_tools" ? "violet" : "neutral"}>
      {mode === "with_tools" ? "with tools" : "no tools"}
    </Badge>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Step-through replay of one recorded trajectory. */
export function AgentClient({ replay }: { replay: ReplayData }) {
  const total = replay.turns.length;
  const [step, setStep] = useState(Math.max(0, total - 1));
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || step >= total - 1) return;
    const handle = setTimeout(() => setStep((s) => Math.min(total - 1, s + 1)), 1400);
    return () => clearTimeout(handle);
  }, [playing, step, total]);

  const revealed = replay.turns.slice(0, step + 1);
  const current = replay.turns[step] ?? null;

  const predBoxes = useMemo<OverlayBox[]>(() => {
    const seen = new Set<string>();
    const out: OverlayBox[] = [];
    for (const turn of replay.turns.slice(0, step + 1)) {
      for (const f of turn.findings) {
        if (!f.bbox) continue;
        const key = `${f.quadrant}-${f.toothPosition}-${f.diagnosis}-${f.bbox.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          bbox: f.bbox,
          tone: "pred",
          label: `Q${f.quadrant}T${f.toothPosition} ${f.diagnosis}`,
        });
      }
    }
    // Terminal turns usually carry the answer; fall back to the trace-level
    // final answer when the per-turn parsed block has no boxes.
    if (out.length === 0 && step >= total - 1) return replay.finalPredBoxes;
    return out;
  }, [replay, step, total]);

  const seenToolCalls = revealed.reduce((n, t) => n + t.toolCalls.length, 0);
  const seenRenders = revealed.reduce(
    (n, t) => n + t.toolCalls.filter((c) => c.imageUrl).length,
    0,
  );

  const togglePlay = () => {
    if (total === 0) return;
    if (step >= total - 1) {
      setStep(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">
                {caseName(replay.dataset, replay.imageId)}
              </h2>
              {modeBadge(replay.mode)}
              <Badge tone={replay.verified ? "success" : "warning"}>
                {replay.verified ? "verified" : "unverified"}
              </Badge>
              <Badge tone={replay.formatOk ? "success" : "warning"}>
                format {replay.formatOk ? "pass" : "fail"}
              </Badge>
              <Badge tone="neutral">{replay.cohort}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">
              recorded trace {replay.id.slice(0, 8)} · {replay.provenance} · replay, not a live call
            </p>
          </div>
          <Link
            href={`/traces/${replay.id}`}
            className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            Full trace →
          </Link>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div>
            {replay.image ? (
              <Radiograph
                src={replay.image.url}
                width={replay.image.width}
                height={replay.image.height}
                gt={replay.gtBoxes}
                pred={predBoxes}
                alt={`${caseName(replay.dataset, replay.imageId)} replay with ground truth and predictions`}
              />
            ) : (
              <div className="flex aspect-[16/8] items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 px-4 text-center text-xs text-zinc-500">
                No public image derivative for this case.
              </div>
            )}
            <p className="mt-2 text-[11px] text-zinc-500">
              {seenRenders > 0
                ? `${seenRenders} stored tool render${seenRenders === 1 ? "" : "s"} revealed so far.`
                : "Ground truth is drawn from the trace; prediction boxes appear as turns complete."}
            </p>
          </div>

          <div className="flex min-w-0 flex-col justify-between gap-3">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  Step {total === 0 ? 0 : step + 1} of {total}
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {seenToolCalls} tool call{seenToolCalls === 1 ? "" : "s"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={step}
                onChange={(e) => {
                  setPlaying(false);
                  setStep(Number(e.target.value));
                }}
                aria-label="Replay step"
                className="mt-2 w-full accent-sky-600"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <ControlButton onClick={() => { setPlaying(false); setStep(0); }} disabled={step === 0}>
                  ⏮ Start
                </ControlButton>
                <ControlButton onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>
                  ← Prev
                </ControlButton>
                <ControlButton onClick={togglePlay} disabled={total === 0}>
                  {playing && step < total - 1 ? "❚❚ Pause" : step >= total - 1 ? "▶ Replay" : "▶ Play"}
                </ControlButton>
                <ControlButton onClick={() => { setPlaying(false); setStep((s) => Math.min(total - 1, s + 1)); }} disabled={step >= total - 1}>
                  Next →
                </ControlButton>
                <ControlButton onClick={() => { setPlaying(false); setStep(Math.max(0, total - 1)); }} disabled={step >= total - 1}>
                  End
                </ControlButton>
              </div>
            </div>

            <div aria-live="polite" className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold">Turn {current?.turn ?? 0}</span>
                {current?.status && <Badge tone="neutral">{current.status}</Badge>}
                {current && current.toolCalls.length > 0 && (
                  <Badge tone="violet">{current.toolCalls.length} tool calls</Badge>
                )}
                {current && current.findings.length > 0 && (
                  <Badge tone="warning">{current.findings.length} findings</Badge>
                )}
              </div>
              {current?.thought ? (
                <p className="mt-2 line-clamp-4 text-xs text-zinc-700 dark:text-zinc-300">
                  {current.thought}
                </p>
              ) : (
                <p className="mt-2 text-xs text-zinc-500">
                  {current?.toolCalls.length
                    ? "Tool-execution turn: the model called a grounding tool."
                    : current?.findings.length
                      ? "Terminal turn: the model returned its findings."
                      : "No narrative text recorded for this turn."}
                </p>
              )}
            </div>

            <div>
              <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                Recorded answer
              </h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {replay.diagnoses.length > 0 ? (
                  replay.diagnoses.map((d) => (
                    <Badge key={d} tone={conditionTone(d)}>
                      {d}
                    </Badge>
                  ))
                ) : (
                  <Badge tone="success">no findings</Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {replay.verifierReason && (
          <div className="border-t border-border bg-muted/30 px-4 py-3">
            <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Verifier note</p>
            <p className="mt-1 line-clamp-3 text-xs text-zinc-600" title={replay.verifierReason}>
              {replay.verifierReason}
            </p>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Turn timeline</h2>
          <span className="text-[11px] text-zinc-500">
            {revealed.length} of {total} revealed
          </span>
        </div>
        <ol className="mt-3 max-h-[34rem] space-y-2 overflow-auto pe-1">
          {revealed.map((turn, i) => {
            const isCurrent = i === step;
            return (
              <li key={`${turn.turn}-${i}`}>
                <div
                  className={`rounded-lg border p-3 transition-colors ${
                    isCurrent
                      ? "border-sky-400 bg-sky-50/60 dark:border-sky-700 dark:bg-sky-950/30"
                      : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">Turn {turn.turn}</span>
                    {turn.status && <Badge tone="neutral">{turn.status}</Badge>}
                    {turn.toolCalls.length > 0 && (
                      <Badge tone="violet">{turn.toolCalls.length} tool calls</Badge>
                    )}
                    {turn.findings.length > 0 && (
                      <Badge tone="warning">{turn.findings.length} findings</Badge>
                    )}
                  </div>

                  {turn.thought && (
                    <p className="mt-2 border-s-2 border-border ps-3 text-xs text-zinc-700 dark:text-zinc-300">
                      {turn.thought.length > 900 ? `${turn.thought.slice(0, 900)}…` : turn.thought}
                    </p>
                  )}

                  {turn.toolCalls.map((call, j) => (
                    <div key={j} className="mt-2 rounded-lg bg-muted/60 p-2 font-mono text-[11px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold">{call.name}</span>
                        {!call.ok && <Badge tone="danger">failed</Badge>}
                      </div>
                      <pre className="mt-1 max-h-24 overflow-auto break-all whitespace-pre-wrap text-zinc-600">
                        {JSON.stringify(call.args)}
                      </pre>
                      {call.isImageOutput &&
                        (call.imageUrl ? (
                          <figure className="mt-2" data-tool-image="artifact">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={call.imageUrl}
                              alt={`${call.name} output (stored artifact)`}
                              loading="lazy"
                              className="max-h-56 w-auto rounded border border-border"
                            />
                            <figcaption className="mt-1 font-sans text-[10px] text-zinc-500">
                              stored render · {call.imageProvenance ?? "artifact"}
                            </figcaption>
                          </figure>
                        ) : (
                          <p className="mt-2 rounded border border-dashed border-border bg-card p-2 font-sans text-[10px] text-zinc-500">
                            No stored render for this call — showing the recorded arguments.
                          </p>
                        ))}
                    </div>
                  ))}

                  {turn.findings.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {turn.findings.map((f, k) => (
                        <li key={k}>
                          <Badge tone={conditionTone(f.diagnosis)}>
                            <span className="font-mono">
                              Q{f.quadrant}T{f.toothPosition}
                            </span>{" "}
                            {f.diagnosis}
                            {f.confidence != null ? ` · ${f.confidence.toFixed(2)}` : ""}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}

                  {turn.rawOutput && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-zinc-500">raw output</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[10px] whitespace-pre-wrap">
                        {turn.rawOutput}
                      </pre>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {step < total - 1 && (
          <p className="mt-2 text-[11px] text-zinc-500">
            {total - 1 - step} later turn{total - 1 - step === 1 ? "" : "s"} hidden. Press Play or Next
            to continue.
          </p>
        )}
      </Card>
    </div>
  );
}

/** Sidebar picker: filter the recorded corpus and switch the replay target. */
export function TracePicker({
  options,
  selectedId,
}: {
  options: TraceOption[];
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | TraceMode>("all");

  const filtered = options.filter((o) => {
    if (mode !== "all" && o.mode !== mode) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      String(o.imageId).includes(q) ||
      o.dataset.toLowerCase().includes(q) ||
      o.mode.includes(q)
    );
  });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Recorded runs</h2>
        <span className="text-[11px] text-zinc-500">
          {filtered.length}/{options.length}
        </span>
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by case id…"
        aria-label="Filter recorded runs"
        className="mt-2 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-500 focus:border-zinc-400"
      />
      <div className="mt-2 flex gap-1.5">
        {(["all", "with_tools", "no_tools"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              mode === m
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-zinc-600 hover:bg-accent"
            }`}
          >
            {m === "all" ? "All" : m === "with_tools" ? "With tools" : "No tools"}
          </button>
        ))}
      </div>

      <ul className="mt-3 max-h-[26rem] space-y-1 overflow-auto pe-1">
        {filtered.map((o) => {
          const selected = o.id === selectedId;
          return (
            <li key={o.id}>
              <Link
                href={`/agent?trace=${o.id}`}
                aria-current={selected ? "page" : undefined}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
                  selected
                    ? "border-sky-400 bg-sky-50/70 dark:border-sky-700 dark:bg-sky-950/30"
                    : "border-transparent hover:bg-accent"
                }`}
              >
                {o.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={o.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-8 w-14 shrink-0 rounded object-cover opacity-90"
                  />
                ) : (
                  <span className="h-8 w-14 shrink-0 rounded bg-muted" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {caseName(o.dataset, o.imageId)}
                  </span>
                  <span className="block text-[10px] text-zinc-500">
                    {o.nTurns} turns · {o.nToolCalls} calls · {o.nFindings} findings
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                    o.mode === "with_tools"
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                      : "bg-zinc-100 text-zinc-600 dark:bg-muted dark:text-zinc-300"
                  }`}
                >
                  {o.mode === "with_tools" ? "tools" : "no tools"}
                </span>
              </Link>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-zinc-500">
            No recorded run matches this filter.
          </li>
        )}
      </ul>
    </Card>
  );
}

type JobErrorBody = { title?: string; detail?: string };

/** Honest live controls: disabled until the worker integration can accept a job. */
export function LiveRunPanel({
  worker,
  resolution,
}: {
  worker: WorkerInfo;
  resolution: AgentResolution;
}) {
  const [imageId, setImageId] = useState("");
  const [modelId, setModelId] = useState("qwen3.5-4b");
  const [mode, setMode] = useState<TraceMode>("with_tools");
  const [maxTurns, setMaxTurns] = useState(30);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const stream = useJobStream(jobId);

  const integrationOff = worker.mode === "off";
  const workerOnline = worker.status !== "offline";
  const canEnqueue =
    !integrationOff && (workerOnline || resolution.queueable) && imageId.trim().length > 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setNeedsSignIn(false);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "agent.run",
          payload: {
            imageId: Number.isFinite(Number(imageId)) ? Number(imageId) : imageId.trim(),
            modelId: modelId.trim(),
            mode,
            maxTurns,
            maxToolCalls: 50,
            canonicalResize: false,
          },
        }),
      });
      const body = (await res.json().catch(() => null)) as (JobErrorBody & { id?: string }) | null;
      if (!res.ok) {
        if (res.status === 401) setNeedsSignIn(true);
        throw new Error(body?.detail ?? body?.title ?? `enqueue failed (${res.status})`);
      }
      if (!body?.id) throw new Error("enqueue returned no job id");
      setJobId(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    } catch {
      // The stream still reports the authoritative status.
    }
  };

  const turns = stream.events.filter((e) => e.type === "turn");
  const logs = stream.events.filter((e) => e.type !== "turn");
  const status = stream.job?.status ?? (jobId ? "queued" : null);
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Live run</h2>
        <Badge tone={workerOnline ? "success" : integrationOff ? "neutral" : "warning"}>
          {integrationOff ? "integration off" : workerOnline ? "worker online" : "no worker"}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        {integrationOff
          ? "Worker integration is off in this deployment. Replay is fully available; live runs cannot be queued."
          : workerOnline
            ? "A worker is attached. Enqueue a run and watch its events stream in."
            : resolution.queueable
              ? "No worker is online. Jobs can still be queued and will run when a worker connects."
              : "No worker is online and jobs cannot be parked in this deployment."}
      </p>

      <div className="mt-3 grid gap-2">
        <label className="text-[11px] font-medium text-zinc-500">
          DENTEX case id or image UUID
          <input
            value={imageId}
            onChange={(e) => setImageId(e.target.value)}
            placeholder="e.g. 255"
            className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-500 focus:border-zinc-400"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] font-medium text-zinc-500">
            Model id
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-400"
            />
          </label>
          <label className="text-[11px] font-medium text-zinc-500">
            Max turns
            <input
              type="number"
              min={1}
              max={60}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-400"
            />
          </label>
        </div>
        <div className="flex gap-1.5">
          {(["with_tools", "no_tools"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`flex-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                mode === m
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-zinc-600 hover:bg-accent"
              }`}
            >
              {m === "with_tools" ? "With tools" : "No tools"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canEnqueue || submitting}
          title={
            integrationOff
              ? "Worker integration is disabled"
              : !workerOnline && !resolution.queueable
                ? "No worker is online and jobs cannot be queued"
                : undefined
          }
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Enqueuing…" : workerOnline ? "Run agent" : "Queue run"}
        </button>
      </div>

      {needsSignIn && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          Sign in with a member account to queue jobs.{" "}
          <Link href="/sign-in" className="font-medium underline">
            Sign in
          </Link>
          .
        </p>
      )}
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {worker.workers.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[11px]">
          {worker.workers.map((w) => (
            <li key={w.name} className="rounded-lg border border-border px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium" title={w.name}>
                  {w.name}
                </span>
                <Badge
                  tone={
                    w.status === "online" ? "success" : w.status === "degraded" ? "warning" : "neutral"
                  }
                >
                  {w.status}
                </Badge>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                {w.runtime} ·{" "}
                {w.lastHeartbeatAt
                  ? new Date(w.lastHeartbeatAt).toISOString().replace("T", " ").slice(0, 19)
                  : "no heartbeat"}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[10px] text-zinc-500">
        Agent strategy: <span className="font-mono">{resolution.strategy}</span> — {resolution.reason}
      </p>

      {jobId && (
        <div className="mt-3 rounded-lg border border-border p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              tone={
                status === "succeeded"
                  ? "success"
                  : status === "failed"
                    ? "danger"
                    : status === "running" || status === "claimed"
                      ? "info"
                      : "neutral"
              }
            >
              {status}
            </Badge>
            <span className="font-mono text-[10px] text-zinc-500">job {jobId.slice(0, 8)}</span>
            <span className="font-mono text-[10px] text-zinc-500">via {stream.transport}</span>
            <span className="font-mono text-[10px] text-zinc-500">{stream.events.length} events</span>
            {!terminal && (
              <button
                type="button"
                onClick={cancel}
                className="ms-auto rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
              >
                Cancel
              </button>
            )}
          </div>

          {turns.length > 0 && (
            <ol className="mt-2 max-h-64 space-y-1.5 overflow-auto">
              {turns.map((e, i) => (
                <li key={e.seq} className="rounded border border-border bg-muted/40 p-2">
                  <div className="text-[10px] font-medium text-zinc-500">
                    turn event {i + 1}
                  </div>
                  <pre className="mt-1 max-h-28 overflow-auto text-[10px] whitespace-pre-wrap">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          )}

          {logs.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] text-zinc-500">
                {logs.length} progress / log / artifact events
              </summary>
              <ul className="mt-1 max-h-40 space-y-1 overflow-auto font-mono text-[10px] text-zinc-500">
                {logs.map((e) => (
                  <li key={e.seq} className="break-all">
                    {e.type}: {JSON.stringify(e.data)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {stream.job?.status === "succeeded" && stream.job.result != null && (
            <details className="mt-2" open>
              <summary className="cursor-pointer text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                Result
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/60 p-2 text-[10px] whitespace-pre-wrap">
                {JSON.stringify(stream.job.result, null, 2)}
              </pre>
            </details>
          )}
          {stream.job?.status === "failed" && (
            <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">
              Failed: {JSON.stringify(stream.job.error)}
            </p>
          )}
          {stream.error && !terminal && (
            <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">stream: {stream.error}</p>
          )}
          {!terminal && turns.length === 0 && logs.length === 0 && (
            <p className="mt-2 text-[11px] text-zinc-500">
              Waiting for the worker{workerOnline ? "" : " to connect"}…
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
