import { Suspense } from "react";
import type { BboxT } from "@/shared/contracts/traces";
import { isImageOutputTool } from "@/shared/domain/toolImage";
import { ProvenanceBadge, resolveFeature, type StrategyResolution } from "@/features/capability";
import { loadPageSnapshot } from "@/features/capability/server";
import type { TraceDetail } from "@/shared/lib/datasource";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { publicImageUrl } from "@/shared/lib/image-url";
import { loadToolImages, type ToolImageInfo } from "@/shared/lib/tool-images";
import { BackLink, PageShell } from "@/shared/ui/page";
import { Badge, Card, Stat, caseName } from "@/shared/ui/primitives";
import { Radiograph, type OverlayBox } from "@/shared/ui/radiograph";

type Finding = {
  quadrant?: number;
  tooth_position?: number;
  diagnosis?: string;
  fdi_quadrant?: number;
  fdi_position?: number;
  pathology?: string;
  bbox?: BboxT;
};

function boxes(findings: Finding[], tone: "gt" | "pred"): OverlayBox[] {
  return findings
    .filter((f) => Array.isArray(f.bbox) && f.bbox.length === 4)
    .map((f) => ({
      bbox: f.bbox as BboxT,
      tone,
      label: `Q${f.quadrant ?? f.fdi_quadrant}T${f.tooth_position ?? f.fdi_position} ${f.diagnosis ?? f.pathology ?? ""}`.trim(),
    }));
}

function conditionTone(diagnosis: string) {
  const d = diagnosis.toLowerCase();
  if (d.includes("healthy") || d.includes("no finding")) return "success" as const;
  if (d.includes("caries")) return "warning" as const;
  return "info" as const;
}

function TraceBody({
  detail,
  resolution,
  toolImages,
}: {
  detail: TraceDetail;
  resolution: StrategyResolution;
  toolImages: Map<string, ToolImageInfo>;
}) {
  const t = detail.trace;
  const finalFindings = t.final_answer ?? [];
  const gt = boxes(t.ground_truth as Finding[], "gt");
  const pred = boxes(finalFindings as Finding[], "pred");
  const img = detail.image ? publicImageUrl(detail.image.storageKey) : null;
  const imgW = detail.image?.width || 16;
  const imgH = detail.image?.height || 9;
  const diagnoses = [...new Set([...finalFindings.map((f) => f.diagnosis), ...t.ground_truth.map((f) => f.diagnosis)])].filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  const toolCalls = t.turns.flatMap((turn) => turn.tool_calls_this_turn ?? []);
  const failedCalls = toolCalls.filter((c) => c.tool_ok === false).length;

  return (
    <div className="mt-6 space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Turns" value={t.turns.length} />
        <Stat label="Tool calls" value={toolCalls.length} hint={failedCalls ? `${failedCalls} failed` : "all ok"} />
        <Stat label="GT findings" value={t.ground_truth.length} />
        <Stat
          label="Format"
          value={t.format_ok ? "pass" : "fail"}
          tone={t.format_ok ? "success" : "warning"}
        />
      </div>

      {t.verifier_reason && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Verifier note</h2>
          <p className="mt-2 line-clamp-3 text-xs text-zinc-600" title={t.verifier_reason}>
            {t.verifier_reason}
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Radiograph &amp; findings</h2>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="success">ground truth {gt.length}</Badge>
              <Badge tone="warning">prediction boxes {pred.length}</Badge>
            </div>
          </div>
          {img ? (
            <Radiograph
              src={img}
              width={imgW}
              height={imgH}
              gt={gt}
              pred={pred}
              alt={`${caseName(t.dataset, t.image_id)} radiograph with ground-truth and prediction boxes`}
            />
          ) : (
            <div className="flex aspect-[16/8] items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 text-sm text-zinc-500">
              No public image derivative for this case.
            </div>
          )}
          {pred.length === 0 && (
            <p className="mt-3 text-xs text-zinc-500">
              This trace has no final-answer boxes. Ground truth is still drawn when present.
            </p>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Recorded answer</h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {diagnoses.length > 0 ? (
                diagnoses.map((d) => (
                  <Badge key={d} tone={conditionTone(d)}>
                    {d}
                  </Badge>
                ))
              ) : (
                <Badge tone="success">no findings</Badge>
              )}
            </div>
            <dl className="mt-4 space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Dataset</dt>
                <dd className="font-mono uppercase">{t.dataset}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Image id</dt>
                <dd className="font-mono">{t.image_id}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Provenance</dt>
                <dd className="max-w-[60%] truncate font-mono" title={detail.provenance}>
                  {detail.provenance}
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="p-4" data-capability-reason>
            <h2 className="text-sm font-semibold">Tool images</h2>
            {toolImages.size > 0 ? (
              <p className="mt-2 text-xs text-zinc-600">
                {toolImages.size} stored render{toolImages.size === 1 ? "" : "s"} linked to this trace.
                Image-output calls below show the recorded render; other calls show their arguments.
              </p>
            ) : (
              <p className="mt-2 text-xs text-zinc-600">
                <ProvenanceBadge resolution={resolution} /> <span className="ms-1">{resolution.reason}</span>
              </p>
            )}
          </Card>

          {(finalFindings.length ?? 0) > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Final findings ({finalFindings.length})</h2>
              <ul className="mt-3 space-y-1.5 text-xs">
                {finalFindings.slice(0, 12).map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 rounded bg-muted/60 px-2 py-1.5">
                    <span className="font-mono">
                      Q{f.quadrant}T{f.tooth_position}
                    </span>
                    <span className="flex-1 truncate">{f.diagnosis}</span>
                    {typeof f.confidence === "number" && (
                      <span className="font-mono text-zinc-500">{f.confidence.toFixed(2)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Turn timeline</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Every recorded turn, including the tool arguments and any stored render.
        </p>
        <ol className="mt-4 space-y-3">
          {t.turns.map((turn, i) => (
            <li key={i} className="relative ps-6">
              <span
                className="absolute top-3 left-0 flex h-3 w-3 items-center justify-center rounded-full border-2 border-background bg-zinc-300 ring-1 ring-border dark:bg-zinc-600"
                aria-hidden="true"
              />
              {i < t.turns.length - 1 && (
                <span className="absolute top-6 bottom-[-12px] left-[5px] w-px bg-border" aria-hidden="true" />
              )}
              <Card className="p-3">
                <details
                  open={
                    i < 2 ||
                    Boolean(
                      turn.tool_calls_this_turn?.some((c) => (c as { artifact_id?: string }).artifact_id),
                    )
                  }
                >
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium">
                    <span>Turn {turn.turn}</span>
                    {turn.status && <Badge tone="neutral">{turn.status}</Badge>}
                    {turn.tool_calls_this_turn && turn.tool_calls_this_turn.length > 0 && (
                      <Badge tone="violet">{turn.tool_calls_this_turn.length} tool calls</Badge>
                    )}
                  </summary>
                  {turn.tool_calls_this_turn?.map((c, j) => {
                    const artifactId = (c as { artifact_id?: string }).artifact_id;
                    const imgInfo = artifactId ? toolImages.get(artifactId) : undefined;
                    return (
                      <div key={j} className="mt-2 rounded-lg bg-muted/60 p-2 font-mono text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{c.tool_name}</span>
                          {c.tool_ok === false && <Badge tone="danger">failed</Badge>}
                          {c.true_bbox ? <Badge tone="warning">perturb {c.perturb_tier}</Badge> : null}
                        </div>
                        <div className="mt-1 break-all text-zinc-600">
                          {JSON.stringify(c.tool_args)}
                        </div>
                        {isImageOutputTool(c.tool_name) &&
                          (imgInfo ? (
                            <figure className="mt-2" data-tool-image="artifact">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={imgInfo.url}
                                alt={`${c.tool_name} output (stored artifact)`}
                                className="max-h-64 w-auto rounded border border-border"
                              />
                              <figcaption className="mt-1 flex items-center gap-1.5 font-sans text-[11px] text-zinc-500">
                                stored artifact <ProvenanceBadge provenance={imgInfo.provenance} />
                              </figcaption>
                            </figure>
                          ) : (
                            <div
                              className="mt-2 rounded border border-dashed border-border bg-card p-2 font-sans text-[11px] text-zinc-500"
                              data-tool-image="placeholder"
                            >
                              No stored render for this call — showing the recorded arguments.
                            </div>
                          ))}
                      </div>
                    );
                  })}
                  {turn.parsed?.thought && (
                    <p className="mt-2 border-s-2 border-border ps-3 text-sm text-zinc-700 dark:text-zinc-300">
                      {turn.parsed.thought.slice(0, 700)}
                    </p>
                  )}
                  {turn.parsed?.final_answer && (
                    <ul className="mt-2 space-y-1 text-sm">
                      {turn.parsed.final_answer.map((f, k) => (
                        <li key={k} className="flex gap-2">
                          <span className="font-mono text-xs text-zinc-500">
                            Q{f.quadrant}T{f.tooth_position}
                          </span>
                          <span>{f.diagnosis}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { source } = await resolveDataSource();
  const detail = await source.getTraceDetail(id);
  const resolution = resolveFeature("trace.render_artifacts", await loadPageSnapshot());
  const toolImages = detail ? await loadToolImages(source, detail.trace) : new Map<string, ToolImageInfo>();
  return (
    <PageShell>
      <BackLink href="/traces">All traces</BackLink>
      {detail ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {caseName(detail.trace.dataset, detail.trace.image_id)}
            </h1>
            <Badge tone={detail.provenance === "postgres" ? "success" : "warning"}>
              {detail.provenance === "postgres" ? "imported data" : "fixture replay"}
            </Badge>
            <Badge tone={detail.mode === "with_tools" ? "violet" : "neutral"}>
              {detail.mode === "with_tools" ? "with tools" : "no tools"}
            </Badge>
            <Badge tone={detail.verified ? "success" : "warning"}>
              {detail.verified ? "verified" : "unverified"}
            </Badge>
            <Badge tone="neutral">{detail.cohort}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-500">trace {id}</p>
        </>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight">Trace not found</h1>
      )}
      <Suspense fallback={<p className="mt-6 text-sm">Loading trace…</p>}>
        {detail ? (
          <TraceBody detail={detail} resolution={resolution} toolImages={toolImages} />
        ) : (
          <p className="mt-6 text-sm text-zinc-600">Trace not found in the {source.provenance} source.</p>
        )}
      </Suspense>
    </PageShell>
  );
}
