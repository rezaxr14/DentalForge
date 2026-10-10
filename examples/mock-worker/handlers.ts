/**
 * Deterministic handlers for every job type, driven by the sanitized fixtures
 * in `fixtures/` (real YOLO predictions, a real verified trace, real eval
 * cases). Image tools return a labeled PLACEHOLDER render — the mock proves the
 * pipe, not the pixels; the worker contract marks real results `worker_exact`
 * and this worker says `mock: true` in its payloads so nothing is mistaken for
 * a real tool output.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fdiLabel } from "@/shared/domain/fdi";
import { nudgeCrop } from "@/shared/domain/toolGeometry";
import { AgentRunPayload, EvalRunPayload, SystemPingPayload, ToolExecutePayload, YoloPrelabelPayload, AlScorePayload } from "@/shared/contracts/worker";
import { placeholderPng } from "./png";
import type { JobContext } from "./worker";

const FIX = join(process.cwd(), "fixtures");
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(FIX, ...p), "utf8")) as T;

interface LabelFixture {
  width: number;
  height: number;
  gt: { bbox: number[]; fdi_quadrant: number; fdi_position: number }[];
  predictions: { bbox: [number, number, number, number]; fdi_quadrant: number; fdi_position: number; confidence: number; class_idx: number }[];
  prediction_model: string;
}
const labelFixture = (imageId: unknown): LabelFixture | null => {
  const n = Number(imageId);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return readJson<LabelFixture>("labels", `${n}.json`);
};

export class NonRetryable extends Error {}

export async function systemPing(ctx: JobContext) {
  const p = SystemPingPayload.parse(ctx.job.payload);
  for (let i = 1; i <= p.steps; i++) {
    await ctx.emit("progress", { pct: Math.round((i / Math.max(1, p.steps)) * 100), step: i });
    await ctx.sleep(ctx.stepDelayMs);
  }
  return { echo: p.message, workerName: ctx.workerName, steps: p.steps };
}

export async function yoloPrelabel(ctx: JobContext) {
  const p = YoloPrelabelPayload.parse(ctx.job.payload);
  const fx = labelFixture(p.imageId);
  if (!fx) throw new NonRetryable(`mock has real predictions only for images 1–5 (got ${String(p.imageId)})`);
  await ctx.emit("progress", { pct: 50 });
  const boxes = fx.predictions
    .filter((b) => b.confidence >= p.confThreshold)
    .map((b) => ({ bbox: b.bbox, conf: b.confidence, classIdx: b.class_idx, fdiQuadrant: b.fdi_quadrant, fdiPosition: b.fdi_position }));
  return { modelId: p.modelId, inferenceMs: 1, boxes };
}

export async function toolExecute(ctx: JobContext) {
  const p = ToolExecutePayload.parse(ctx.job.payload);
  const started = Date.now();
  const a = p.args as Record<string, unknown>;
  const done = (data: unknown) => ({ kind: "data" as const, data, durationMs: Date.now() - started });

  if (p.tool === "fdi_label") {
    return done({ label: fdiLabel(Number(a.quadrant), Number(a.tooth_position)) });
  }
  const fx = labelFixture(p.imageId);
  if (p.tool === "nudge_crop") {
    if (!fx) throw new NonRetryable("nudge_crop needs the image size; the mock knows images 1–5");
    const r = nudgeCrop(fx.width, fx.height, a.bbox as number[], Number(a.dx_frac ?? 0), Number(a.dy_frac ?? 0), Number(a.scale ?? 1));
    if (r.error) throw new NonRetryable(r.error);
    return done({ bbox: r.bbox });
  }
  if (p.tool === "locate_tooth") {
    const tooth = Number(a.tooth);
    const hit = fx?.gt.find((g) => g.fdi_quadrant * 10 + g.fdi_position === tooth);
    if (!hit) throw new NonRetryable(`tooth ${tooth} is not in the mock's ground truth for image ${String(p.imageId)}`);
    return done({ tooth, bbox: hit.bbox, confidence: 1, note: "GT-grounded replay (mock)" });
  }
  // Image tools: a labeled placeholder, uploaded through the real presign → PUT path.
  const seed = [...p.tool].reduce((s, c) => s + c.charCodeAt(0), 0);
  const [w, h] = p.tool === "contralateral_compare" ? [128, 96] : p.tool === "zoom_crop" ? [64, 96] : [192, 96];
  const png = placeholderPng(w, h, seed);
  await ctx.emit("progress", { pct: 80, note: "uploading placeholder render" });
  const artifactId = await ctx.upload(`${p.tool}.png`, "image/png", png);
  return { kind: "image" as const, artifactId, width: w, height: h, durationMs: Date.now() - started, data: { mock: true } };
}

export async function agentRun(ctx: JobContext) {
  const p = AgentRunPayload.parse(ctx.job.payload);
  const file = p.mode === "with_tools" ? "verified_with_tools.json" : "verified_no_tools.json";
  const trace = readJson<{
    turns: Record<string, unknown>[];
    tool_calls?: number;
    final_answer: unknown[] | null;
    format_ok: boolean;
  }>("traces", file);
  for (const turn of trace.turns) {
    await ctx.emit("turn", turn);
    await ctx.sleep(ctx.stepDelayMs);
  }
  return {
    finalAnswer: trace.final_answer ?? [],
    nTurns: trace.turns.length,
    nToolCalls: trace.tool_calls ?? 0,
    formatOk: trace.format_ok,
  };
}

export async function evalRun(ctx: JobContext) {
  const p = EvalRunPayload.parse(ctx.job.payload);
  const known = ["kimi_k3", "gemini_flash", "llama11b", "qwen"];
  const pick = known.includes(p.modelId) ? [p.modelId] : known;
  const cases = pick.map((m) => readJson<{ fdi_f1?: number; exact_f1?: number }>("evals", `${m}.json`));
  let i = 0;
  for (const c of cases) {
    await ctx.emit("partial", { case: ++i, fdi_f1: c.fdi_f1 ?? 0, exact_f1: c.exact_f1 ?? 0 });
  }
  const mean = (k: "fdi_f1" | "exact_f1") => cases.reduce((s, c) => s + (c[k] ?? 0), 0) / cases.length;
  return { runId: randomUUID(), n: cases.length, summary: { fdi_f1: mean("fdi_f1"), exact_f1: mean("exact_f1") } };
}

export async function alScore(ctx: JobContext) {
  const p = AlScorePayload.parse(ctx.job.payload);
  const scores = p.imageIds.map((id) => {
    const fx = labelFixture(id);
    const confs = fx?.predictions.map((b) => b.confidence) ?? [];
    const mean = confs.length ? confs.reduce((s, c) => s + c, 0) / confs.length : 0;
    return { imageId: id, meanConf: mean, minConf: confs.length ? Math.min(...confs) : 0, entropy: confs.length ? -Math.log(Math.max(mean, 1e-9)) : 0, nBoxes: confs.length };
  });
  return { scores };
}

export const HANDLERS: Record<string, (ctx: JobContext) => Promise<unknown>> = {
  "system.ping": systemPing,
  "yolo.prelabel": yoloPrelabel,
  "tool.execute": toolExecute,
  "agent.run": agentRun,
  "eval.run": evalRun,
  "al.score": alScore,
  // `trace.render_artifacts` needs the real image + stored traces; the mock does not claim it.
};
