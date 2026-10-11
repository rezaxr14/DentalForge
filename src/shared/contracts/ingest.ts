/**
 * Worker contract v1 — model registration and training-metric ingestion
 * (plan §10.1, M8 task C1; deviations in ADR-0011).
 *
 * These schemas are the single source of truth: the handlers validate with
 * them and `contract:docs` renders them into docs/worker-openapi.json.
 */
import { z } from "zod";

/** Largest magnitude a Postgres `real` (float4) can hold; beyond it the INSERT would overflow. */
export const FLOAT4_MAX = 3.4028234663852886e38;

const finiteFloat4 = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) <= FLOAT4_MAX, "must fit a 32-bit float");

// --- POST /models/register -------------------------------------------------
export const ModelKind = z.enum(["yolo", "vlm", "api"]);
export const ModelStage = z.enum(["zero_shot", "sft", "grpo", "yolo"]);

export const RegisterModelRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: ModelKind,
    stage: ModelStage,
    /** Where the weights live, e.g. `Reza-Nadimi/vlm-dental-models/grpo`. Omitted on a re-register = keep the stored value. */
    hfPath: z.string().trim().min(1).max(500).optional(),
    /** Free-form, e.g. base model, LoRA rank, training run name. Omitted on a re-register = keep the stored value. */
    meta: z.record(z.string(), z.unknown()).optional(),
    /** An uploaded ONNX export (artifact of kind `model` in this organization). Omitted = keep the stored value. */
    onnxArtifactId: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    // Documented in the field description of the generated schema consumers read, enforced here.
    if ((v.kind === "yolo") !== (v.stage === "yolo")) {
      ctx.addIssue({ code: "custom", path: ["stage"], message: 'kind "yolo" and stage "yolo" go together' });
    }
  });
export type RegisterModelRequestT = z.infer<typeof RegisterModelRequest>;

export const RegisterModelResponse = z.object({
  modelId: z.string().uuid(),
  /** True the first time (org, name, stage) is registered; false when this call updated an existing entry. */
  created: z.boolean(),
  name: z.string(),
  kind: ModelKind,
  stage: ModelStage,
});
export type RegisterModelResponseT = z.infer<typeof RegisterModelResponse>;

// --- POST /ingest/metrics --------------------------------------------------
export const TrainingKind = z.enum(["sft", "grpo", "yolo"]);
export const TrainingStatus = z.enum(["queued", "running", "succeeded", "failed"]);

/** Nothing else creates a training run, so the run is declared inline and identified by (kind, name). */
export const TrainingRunSpec = z.object({
  kind: TrainingKind,
  name: z.string().trim().min(1).max(200),
  /** Hyper-parameters etc. Omitted on a later call = keep the stored value. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Never moves backwards (queued → running → succeeded|failed; terminal is final). Omitted = keep. New runs start `running`. */
  status: TrainingStatus.optional(),
});

export const MetricPoint = z.object({
  step: z.number().int().min(0).max(2_147_483_647),
  name: z.string().trim().min(1).max(100),
  /** Stored as a 32-bit float. */
  value: finiteFloat4,
});

export const RewardSample = z.object({
  step: z.number().int().min(0).max(2_147_483_647),
  /** Stable reference to the sampled trajectory (e.g. `<image_id>:<group>:<k>`). With `step` it identifies the sample. */
  trajectoryRef: z.string().trim().min(1).max(300),
  /** GRPO reward components, e.g. `{accuracy, format, tool_validity, efficiency}`. */
  components: z.record(z.string().min(1).max(100), finiteFloat4),
  total: finiteFloat4,
});

export const MAX_METRICS_PER_REQUEST = 5000;
export const MAX_REWARD_SAMPLES_PER_REQUEST = 500;

export const IngestMetricsRequest = z
  .object({
    run: TrainingRunSpec,
    metrics: z.array(MetricPoint).max(MAX_METRICS_PER_REQUEST).default([]),
    rewardSamples: z.array(RewardSample).max(MAX_REWARD_SAMPLES_PER_REQUEST).default([]),
  })
  .superRefine((v, ctx) => {
    // Duplicate keys inside one batch would make "which value wins" ambiguous: refuse instead of guessing.
    const seenMetric = new Map<string, number>();
    v.metrics.forEach((m, i) => {
      const key = `${m.step}\u0000${m.name}`;
      const first = seenMetric.get(key);
      if (first !== undefined) {
        ctx.addIssue({ code: "custom", path: ["metrics", i], message: `duplicate of metrics[${first}] (step ${m.step}, name "${m.name}")` });
      } else seenMetric.set(key, i);
    });
    const seenReward = new Map<string, number>();
    v.rewardSamples.forEach((r, i) => {
      const key = `${r.step}\u0000${r.trajectoryRef}`;
      const first = seenReward.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rewardSamples", i],
          message: `duplicate of rewardSamples[${first}] (step ${r.step}, trajectoryRef "${r.trajectoryRef}")`,
        });
      } else seenReward.set(key, i);
    });
  });
export type IngestMetricsRequestT = z.infer<typeof IngestMetricsRequest>;

const WriteCounts = z.object({
  received: z.number().int(),
  /** Rows that did not exist before. `received - inserted` rows already existed and were overwritten (same key, latest value wins). */
  inserted: z.number().int(),
});

export const IngestMetricsResponse = z.object({
  runId: z.string().uuid(),
  runCreated: z.boolean(),
  /** The status now stored — differs from the requested one when the request would have moved it backwards. */
  status: TrainingStatus,
  metrics: WriteCounts,
  rewardSamples: WriteCounts,
});
export type IngestMetricsResponseT = z.infer<typeof IngestMetricsResponse>;
