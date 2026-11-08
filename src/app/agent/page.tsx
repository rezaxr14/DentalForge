import type { BboxT } from "@/shared/contracts/traces";
import { isImageOutputTool } from "@/shared/domain/toolImage";
import { resolveFeature } from "@/features/capability";
import { loadPageSnapshot } from "@/features/capability/server";
import type { TraceDetail } from "@/shared/lib/datasource";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { publicImageUrl } from "@/shared/lib/image-url";
import { loadToolImages, type ToolImageInfo } from "@/shared/lib/tool-images";
import { PageShell } from "@/shared/ui/page";
import { Badge, Card, EmptyState, Stat, caseName } from "@/shared/ui/primitives";
import { Radiograph, type OverlayBox } from "@/shared/ui/radiograph";
import {
  AgentClient,
  LiveRunPanel,
  TracePicker,
  type AgentResolution,
  type CompareSummary,
  type ReplayData,
  type TraceOption,
  type WorkerInfo,
} from "./agent-client";

type Finding = {
  quadrant?: number;
  tooth_position?: number;
  diagnosis?: string;
  confidence?: number;
  bbox?: BboxT;
};

function boxes(findings: Finding[], tone: "gt" | "pred"): OverlayBox[] {
  return findings
    .filter((f) => Array.isArray(f.bbox) && f.bbox.length === 4)
    .map((f) => ({
      bbox: f.bbox as BboxT,
      tone,
      label: `Q${f.quadrant}T${f.tooth_position} ${f.diagnosis ?? ""}`.trim(),
    }));
}

function toolImageKey(call: { artifact_id?: unknown }): string | null {
  return typeof call.artifact_id === "string" && call.artifact_id.length > 0
    ? call.artifact_id
    : null;
}

function countArtifacts(detail: TraceDetail): number {
  return detail.trace.turns.reduce(
    (n, turn) =>
      n +
      (turn.tool_calls_this_turn ?? []).filter((c) =>
        toolImageKey(c as { artifact_id?: unknown }),
      ).length,
    0,
  );
}

function toReplay(detail: TraceDetail, toolImages: Map<string, ToolImageInfo>): ReplayData {
  const t = detail.trace;
  const finalAnswer = t.final_answer ?? [];
  const diagnoses = [
    ...new Set(
      [...finalAnswer, ...t.ground_truth]
        .map((f) => f.diagnosis)
        .filter((d): d is string => typeof d === "string" && d.length > 0),
    ),
  ];
  return {
    id: detail.id,
    dataset: t.dataset,
    imageId: t.image_id,
    mode: detail.mode,
    cohort: detail.cohort,
    verified: detail.verified,
    provenance: detail.provenance,
    nTurns: t.turns.length,
    nToolCalls: t.turns.reduce((n, turn) => n + (turn.tool_calls_this_turn?.length ?? 0), 0),
    formatOk: t.format_ok,
    verifierReason: t.verifier_reason ?? null,
    image: (() => {
      const url = detail.image ? publicImageUrl(detail.image.storageKey) : null;
      return url && detail.image
        ? { url, width: detail.image.width || 16, height: detail.image.height || 9 }
        : null;
    })(),
    gtBoxes: boxes(t.ground_truth as Finding[], "gt"),
    finalPredBoxes: boxes(finalAnswer as Finding[], "pred"),
    diagnoses,
    turns: t.turns.map((turn) => ({
      turn: turn.turn,
      status: turn.status ?? null,
      thought: turn.parsed?.thought ?? null,
      rawOutput: turn.raw_output ?? null,
      findings: (turn.parsed?.final_answer ?? []).map((f) => ({
        quadrant: f.quadrant,
        toothPosition: f.tooth_position,
        diagnosis: f.diagnosis,
        confidence: f.confidence ?? null,
        bbox: f.bbox ?? null,
      })),
      toolCalls: (turn.tool_calls_this_turn ?? []).map((c) => {
        const artifactId = toolImageKey(c as { artifact_id?: unknown });
        const info = artifactId ? toolImages.get(artifactId) : undefined;
        return {
          name: c.tool_name,
          args: c.tool_args,
          ok: c.tool_ok,
          isImageOutput: isImageOutputTool(c.tool_name),
          imageUrl: info?.url ?? null,
          imageProvenance: info?.provenance ?? null,
        };
      }),
    })),
  };
}

function toOption(row: {
  id: string;
  dataset: string;
  imageId: number;
  mode: "with_tools" | "no_tools";
  nTurns: number;
  nToolCalls: number;
  nFindings: number;
  formatOk: boolean;
  verified: boolean;
  imageKey: string | null;
}): TraceOption {
  return {
    id: row.id,
    dataset: row.dataset,
    imageId: row.imageId,
    mode: row.mode,
    nTurns: row.nTurns,
    nToolCalls: row.nToolCalls,
    nFindings: row.nFindings,
    formatOk: row.formatOk,
    verified: row.verified,
    imageUrl: publicImageUrl(row.imageKey),
  };
}

export default async function AgentPage({
  searchParams,
}: {
  searchParams?: Promise<{ trace?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const { source, fallbackReason } = await resolveDataSource();
  const traces = await source.listTraces();

  const requested = (sp.trace ?? "").trim();
  const requestedDetail = requested ? await source.getTraceDetail(requested) : null;

  // Default to the richest trace that also has stored tool renders, so the
  // landing state shows the full replay (and never invents a render count).
  let detail = requestedDetail;
  if (!detail) {
    const candidates = [...traces]
      .filter((t) => t.imageKey)
      .sort(
        (a, b) =>
          Number(b.mode === "with_tools") - Number(a.mode === "with_tools") ||
          b.nToolCalls - a.nToolCalls ||
          b.nTurns - a.nTurns,
      )
      .slice(0, 6);
    const loaded = (
      await Promise.all(candidates.map((row) => source.getTraceDetail(row.id)))
    ).filter((d): d is TraceDetail => Boolean(d));
    loaded.sort(
      (a, b) =>
        countArtifacts(b) - countArtifacts(a) ||
        b.trace.turns.length - a.trace.turns.length,
    );
    detail = loaded[0] ?? null;
  }

  const [snapshot, toolImages] = await Promise.all([
    loadPageSnapshot(),
    detail ? loadToolImages(source, detail.trace) : Promise.resolve(new Map()),
  ]);
  const resolution = resolveFeature("agent.run", snapshot);

  const replay = detail ? toReplay(detail, toolImages) : null;
  const options = [...traces]
    .map(toOption)
    .sort(
      (a, b) =>
        a.imageId - b.imageId ||
        Number(a.mode === "no_tools") - Number(b.mode === "no_tools"),
    );

  const counterpartRow = detail
    ? traces.find(
        (t) =>
          t.id !== detail.id &&
          t.dataset === detail.trace.dataset &&
          t.imageId === detail.trace.image_id &&
          t.mode !== detail.mode,
      )
    : undefined;
  const compare: CompareSummary | null = counterpartRow
    ? {
        id: counterpartRow.id,
        mode: counterpartRow.mode,
        nTurns: counterpartRow.nTurns,
        nToolCalls: counterpartRow.nToolCalls,
        nFindings: counterpartRow.nFindings,
        formatOk: counterpartRow.formatOk,
        verified: counterpartRow.verified,
      }
    : null;

  const worker: WorkerInfo = {
    mode: snapshot.mode,
    status: snapshot.status,
    reason: snapshot.reason ?? null,
    workers: snapshot.workers.map((w) => ({
      name: w.name,
      runtime: w.runtime,
      status: w.status,
      lastHeartbeatAt: w.lastHeartbeatAt,
      capabilities: w.capabilities,
    })),
  };
  const agentResolution: AgentResolution = {
    strategy: resolution.strategy,
    reason: resolution.reason,
    queueable: resolution.queueable,
  };

  const totalTurns = traces.reduce((n, t) => n + t.nTurns, 0);
  const totalToolCalls = traces.reduce((n, t) => n + t.nToolCalls, 0);

  return (
    <PageShell className="py-10">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Live Agent</h1>
        <Badge tone={worker.status === "online" ? "success" : "warning"}>
          worker {worker.status}
        </Badge>
        <Badge tone="violet">recorded replay</Badge>
        <Badge tone={source.provenance === "postgres" ? "success" : "warning"}>
          {source.provenance === "postgres" ? "imported data" : "fixture replay"}
        </Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        Step through a recorded multi-turn run — every thought, tool call, stored render and finding
        comes from the trace file. Live controls unlock only when a worker heartbeats; nothing here
        pretends a recording is a fresh model call.
      </p>
      {fallbackReason && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {fallbackReason}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Recorded traces" value={traces.length} hint="replayable runs" />
        <Stat label="Turns" value={totalTurns} hint="step-through timeline" />
        <Stat label="Tool calls" value={totalToolCalls} hint="arguments + stored renders" />
        <Stat
          label="Selected renders"
          value={toolImages.size}
          hint={detail ? caseName(detail.trace.dataset, detail.trace.image_id) : "no trace"}
          tone={toolImages.size > 0 ? "success" : "default"}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {replay ? (
            <AgentClient replay={replay} />
          ) : (
            <EmptyState title="No trace to replay">
              Import traces or seed the demo bundle, then reload this page.
            </EmptyState>
          )}

          {detail && (
            <Card className="p-4">
              <details>
                <summary className="cursor-pointer text-sm font-semibold">
                  Ground truth radiograph ({replay?.gtBoxes.length ?? 0} annotations)
                </summary>
                <p className="mt-2 text-xs text-zinc-600">
                  Full-width ground truth. Predictions appear in the replay above as turns complete.
                </p>
                {replay?.image ? (
                  <Radiograph
                    className="mt-3"
                    src={replay.image.url}
                    width={replay.image.width}
                    height={replay.image.height}
                    gt={replay.gtBoxes}
                    alt={`${caseName(detail.trace.dataset, detail.trace.image_id)} ground truth`}
                  />
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-6 text-center text-xs text-zinc-500">
                    No public image derivative for this case.
                  </p>
                )}
              </details>
            </Card>
          )}
        </div>

        <aside className="min-w-0 space-y-4">
          <LiveRunPanel worker={worker} resolution={agentResolution} />
          <TracePicker options={options} selectedId={detail?.id ?? null} />
          {compare && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Same case, other mode</h2>
                <Badge tone={compare.mode === "with_tools" ? "violet" : "neutral"}>
                  {compare.mode === "with_tools" ? "with tools" : "no tools"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-600">
                {caseName(detail?.trace.dataset ?? "dentex", detail?.trace.image_id ?? 0)} also has a
                recorded {compare.mode === "with_tools" ? "tool-using" : "no-tools"} run. Compare the
                two trajectories on the same radiograph.
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-muted/60 px-2 py-1.5">
                  <dt className="text-zinc-500">Turns</dt>
                  <dd className="font-mono tabular-nums">{compare.nTurns}</dd>
                </div>
                <div className="rounded-lg bg-muted/60 px-2 py-1.5">
                  <dt className="text-zinc-500">Tool calls</dt>
                  <dd className="font-mono tabular-nums">{compare.nToolCalls}</dd>
                </div>
                <div className="rounded-lg bg-muted/60 px-2 py-1.5">
                  <dt className="text-zinc-500">Findings</dt>
                  <dd className="font-mono tabular-nums">{compare.nFindings}</dd>
                </div>
                <div className="rounded-lg bg-muted/60 px-2 py-1.5">
                  <dt className="text-zinc-500">Format</dt>
                  <dd className={compare.formatOk ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>
                    {compare.formatOk ? "pass" : "fail"}
                  </dd>
                </div>
              </dl>
              <a
                href={`/agent?trace=${compare.id}`}
                className="mt-3 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
              >
                Replay this run →
              </a>
            </Card>
          )}
        </aside>
      </div>
    </PageShell>
  );
}
