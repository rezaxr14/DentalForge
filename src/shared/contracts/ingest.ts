/**
 * Worker contract v1 — model registration and training-metric ingestion
 * (plan §10.1, M8 task C1; deviations in ADR-0011).
 *
 * These schemas are the single source of truth: the handlers validate with
 * them and `contract:docs` renders them into docs/worker-openapi.json.
 */
import { z } from "zod";
import { EvalCase, VerifiedTrace } from "./traces";

/** Largest magnitude a Postgres `real` (float4) can hold; beyond it the INSERT would overflow. */
export const FLOAT4_MAX = 3.4028234663852886e38;

const finiteFloat4 = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) <= FLOAT4_MAX, "must fit a 32-bit float");

// --- POST /models/register -------------------------------------------------
export const ModelKind = z.enum(["yolo", "vlm", "api"]);
/**
 * `test` is the local LM Studio / API-served backend used only to exercise the pipeline
 * before a trained adapter exists (ADR-0025). Rows with stage `test` are excluded from
 * cohort statistics and benchmark tables by default.
 */
export const ModelStage = z.enum(["zero_shot", "sft", "grpo", "yolo", "test"]);

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

// --- POST /ingest/traces ---------------------------------------------------

/** Cohort labels are slugs; `hybrid` is the importer's skip-me union label and is never a real cohort. */
export const COHORT_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
export const MAX_TRACES_PER_REQUEST = 100;

/** Which worker backend produced a live run (ADR-0025). Omitted for file imports. */
export const RunBackend = z.enum(["torch_hf", "openai_compat"]);
/**
 * The model stage a live run used. Deliberately the worker's own vocabulary (`base`, not the model
 * registry's `zero_shot`): this is provenance for the run, not a registry key. `test` marks the
 * LM Studio backend and is excluded from cohort statistics and benchmark tables by default.
 */
export const RunStage = z.enum(["base", "sft", "grpo", "test"]);

export const TraceBatchSource = z.object({
  cohort: z
    .string()
    .regex(COHORT_PATTERN, "lowercase letters, digits and underscores, up to 64 characters")
    .refine((c) => c !== "hybrid", 'the "hybrid" union label is not a cohort'),
  mode: z.enum(["with_tools", "no_tools"]),
  /** Applies to every trace in the batch. */
  verified: z.boolean().default(true),
  /** Free-form provenance label stored with each new trace (e.g. the run or file the worker produced them from). */
  sourceFile: z.string().trim().min(1).max(300).optional(),
  /** Backend that produced these live traces; omitted for file imports (ADR-0025). */
  backend: RunBackend.optional(),
  /** Model stage of the run; `test` is excluded from cohort statistics/benchmarks by default (ADR-0025). */
  stage: RunStage.optional(),
});

/**
 * A verified trace as the importer reads it (`VerifiedTrace`, plan §4.3), except that `messages` (the full chat
 * transcript, large) and `image_path` (machine-specific, never used to locate images) may be omitted. They are
 * never persisted and never part of the content hash, so including them changes nothing.
 */
export const IngestTrace = VerifiedTrace.extend({
  image_path: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
});
export type IngestTraceT = z.infer<typeof IngestTrace>;

export const IngestTracesRequest = z.object({
  source: TraceBatchSource,
  traces: z.array(IngestTrace).min(1).max(MAX_TRACES_PER_REQUEST),
});
export type IngestTracesRequestT = z.infer<typeof IngestTracesRequest>;

export const TraceOutcome = z.enum(["inserted", "existing", "rejected"]);
export const TraceRejectReason = z.enum(["unknown_dataset", "unknown_image", "invalid_trace"]);

export const IngestTraceResultItem = z.object({
  /** Position in the request's `traces` array. */
  index: z.number().int(),
  /** The trace's own `image_id` (the dataset's image number), echoed for convenience. */
  imageId: z.number().int(),
  outcome: TraceOutcome,
  /** Present for `inserted` and `existing`. */
  traceId: z.string().uuid().optional(),
  /** `existing` only: whether the stored content hash equals this trace's. `false` = same identity, different content; the FIRST import is kept. */
  sameContent: z.boolean().optional(),
  /** `rejected` only. */
  reason: TraceRejectReason.optional(),
});

export const IngestTracesResponse = z.object({
  results: z.array(IngestTraceResultItem),
  inserted: z.number().int(),
  existing: z.number().int(),
  rejected: z.number().int(),
});
export type IngestTracesResponseT = z.infer<typeof IngestTracesResponse>;

// --- POST /ingest/eval-run -------------------------------------------------
/** A worker-chosen identity for a run, unique within the organization (e.g. `zs-qwen3.5-9b-dentex-test-2026-10-11`). */
export const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
export const MAX_EVAL_CASES_PER_REQUEST = 100;

export const IngestEvalRunRequest = z
  .object({
    runKey: z.string().regex(RUN_KEY_PATTERN, "letters, digits, . _ : - ; up to 120 characters; must start with a letter or digit"),
    /** Whether images were resized to the canonical size before inference. Fixed when the run is created. */
    canonicalResize: z.boolean().default(false),
    /** Backend that produced this run; omitted for file imports (ADR-0025). */
    backend: RunBackend.optional(),
    /** Model stage of the run; `test` is excluded from benchmark tables by default (ADR-0025). */
    stage: RunStage.optional(),
    /** One chunk of the run (an eval case is the same record the zero-shot runner writes as a JSONL line). */
    cases: z.array(EvalCase).min(1).max(MAX_EVAL_CASES_PER_REQUEST),
  })
  .superRefine((v, ctx) => {
    const first = v.cases[0];
    if (!first) return;
    const seen = new Map<number, number>();
    v.cases.forEach((c, i) => {
      for (const k of ["dataset", "split", "provider", "model"] as const) {
        if (c[k] !== first[k]) {
          ctx.addIssue({ code: "custom", path: ["cases", i, k], message: `must equal cases[0].${k} ("${first[k]}"): one run, one ${k}` });
        }
      }
      const prior = seen.get(c.image_id);
      if (prior !== undefined) {
        ctx.addIssue({ code: "custom", path: ["cases", i, "image_id"], message: `duplicate of cases[${prior}] (image_id ${c.image_id})` });
      } else seen.set(c.image_id, i);
    });
  });
export type IngestEvalRunRequestT = z.infer<typeof IngestEvalRunRequest>;

export const IngestEvalRunResponse = z.object({
  runId: z.string().uuid(),
  runCreated: z.boolean(),
  dataset: z.string(),
  split: z.string(),
  provider: z.string(),
  model: z.string(),
  /** Number of cases stored for the whole run after this request (not just this chunk). */
  n: z.number().int(),
  cases: z.object({
    received: z.number().int(),
    /** New cases; `received - inserted` already existed and were overwritten (same image, latest value wins). */
    inserted: z.number().int(),
  }),
  /** Means over ALL stored cases of the run (recomputed, never accumulated), as 32-bit-float inputs. */
  summary: z.record(z.string(), z.number()),
});
export type IngestEvalRunResponseT = z.infer<typeof IngestEvalRunResponse>;
