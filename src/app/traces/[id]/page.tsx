import Link from "next/link";
import { Suspense } from "react";
import type { VerifiedTraceT } from "@/shared/contracts/traces";
import { isImageOutputTool } from "@/shared/domain/toolImage";
import { ProvenanceBadge, resolveFeature, type StrategyResolution } from "@/features/capability";
import { loadPageSnapshot } from "@/features/capability/server";
import type { ArtifactImageRef, DataSource } from "@/shared/lib/datasource";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { getStorageAdapter } from "@/shared/jobs/deps";

interface ToolImageInfo {
  url: string;
  provenance: ArtifactImageRef["provenance"];
}

/**
 * Resolve stored tool-image artifacts for one trace (§9 ladder, rung 1).
 * Any failure — no artifacts, storage unconfigured, bad env — yields an empty
 * map and the viewer falls back to the placeholder with args (plan §9 rule 4).
 */
async function loadToolImages(
  source: DataSource,
  trace: VerifiedTraceT,
): Promise<Map<string, ToolImageInfo>> {
  const ids = trace.turns
    .flatMap((t) => t.tool_calls_this_turn ?? [])
    .map((c) => (c as { artifact_id?: string }).artifact_id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const out = new Map<string, ToolImageInfo>();
  if (ids.length === 0) return out;
  let refs: ArtifactImageRef[];
  try {
    refs = await source.getArtifactImages(ids);
  } catch {
    return out;
  }
  if (refs.length === 0) return out;
  try {
    const storage = getStorageAdapter();
    for (const a of refs) {
      try {
        out.set(a.id, { url: await storage.presignDownload(a.storageKey, 600), provenance: a.provenance });
      } catch {
        // One bad key must not hide the rest — this call shows its placeholder.
      }
    }
  } catch {
    // Storage/env unavailable → placeholders with args (the honest fallback).
  }
  return out;
}

function TraceBody({
  trace,
  resolution,
  toolImages,
}: {
  trace: VerifiedTraceT;
  resolution: StrategyResolution;
  toolImages: Map<string, ToolImageInfo>;
}) {
  const t = trace;
  return (
    <div className="mt-6 space-y-4">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded border p-2">Dataset: {t.dataset}</div>
        <div className="rounded border p-2">Image: {t.image_id}</div>
        <div className="rounded border p-2">Turns: {t.turns.length}</div>
        <div className="rounded border p-2">GT findings: {t.ground_truth.length}</div>
      </div>

      {/* Tool-image ladder status (plan §9.2): stored artifact → placeholder. */}
      <p
        className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-xs text-zinc-600"
        data-capability-reason
      >
        Tool images: <ProvenanceBadge resolution={resolution} />{" "}
        <span className="ms-1">{resolution.reason}</span>
      </p>

      {t.turns.map((turn, i) => (
        <details key={i} className="rounded border p-3" open={i < 2}>
          <summary className="cursor-pointer text-sm font-medium">
            Turn {turn.turn}
            {turn.status ? ` · ${turn.status}` : ""}
            {turn.tool_calls_this_turn ? ` · ${turn.tool_calls_this_turn.length} tool calls` : ""}
          </summary>
          {turn.tool_calls_this_turn?.map((c, j) => {
            const artifactId = (c as { artifact_id?: string }).artifact_id;
            const img = artifactId ? toolImages.get(artifactId) : undefined;
            return (
              <div key={j} className="mt-2 rounded bg-zinc-50 p-2 font-mono text-xs">
                {c.tool_name}({JSON.stringify(c.tool_args)})
                {c.true_bbox ? ` · perturb:${c.perturb_tier}` : ""}
                {isImageOutputTool(c.tool_name) &&
                  (img ? (
                    <figure className="mt-2" data-tool-image="artifact">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={`${c.tool_name} output (stored artifact)`}
                        className="max-h-64 w-auto rounded border border-zinc-200"
                      />
                      <figcaption className="mt-1 flex items-center gap-1.5 font-sans text-[11px] text-zinc-500">
                        stored artifact
                        <ProvenanceBadge provenance={img.provenance} />
                      </figcaption>
                    </figure>
                  ) : (
                    <div
                      className="mt-2 rounded border border-dashed border-zinc-300 bg-white p-2 font-sans text-[11px] text-zinc-500"
                      data-tool-image="placeholder"
                    >
                      <p className="font-medium text-zinc-600">
                        No stored render for this tool call — showing the recorded arguments.
                      </p>
                      <p className="mt-1 break-all font-mono">
                        {c.tool_name}({JSON.stringify(c.tool_args)})
                      </p>
                      <p className="mt-1">{resolution.reason}</p>
                    </div>
                  ))}
              </div>
            );
          })}
          {turn.parsed?.thought && (
            <p className="mt-2 text-sm text-zinc-700">{turn.parsed.thought.slice(0, 600)}</p>
          )}
          {turn.parsed?.final_answer && (
            <ul className="mt-2 text-sm">
              {turn.parsed.final_answer.map((f, k) => (
                <li key={k}>
                  Q{f.quadrant}T{f.tooth_position}: {f.diagnosis}
                  {f.confidence !== undefined ? ` (${f.confidence.toFixed(2)})` : ""}
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </div>
  );
}

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { source } = await resolveDataSource();
  const detail = await source.getTraceDetail(id);
  // Resolved once for the whole page: how trace tool images run *right now*.
  const resolution = resolveFeature("trace.render_artifacts", await loadPageSnapshot());
  const toolImages = detail ? await loadToolImages(source, detail.trace) : new Map<string, ToolImageInfo>();
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/traces" className="text-sm underline">
        ← All traces
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Trace {id.slice(0, 8)}</h1>
      <Suspense fallback={<p className="mt-6 text-sm">Loading trace…</p>}>
        {detail ? (
          <TraceBody trace={detail.trace} resolution={resolution} toolImages={toolImages} />
        ) : (
          <p className="mt-6 text-sm text-zinc-600">
            Trace not found in the {source.provenance} source.
          </p>
        )}
      </Suspense>
    </main>
  );
}
