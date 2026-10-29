/**
 * Worker Contract v1 (Plan §10)
 *
 * Base path: `/api/worker/v1`
 * Auth: `Authorization: Bearer tf_wrk_<token>` (stored hashed, scoped to one org)
 * Header: `X-Contract-Version: 1` required; errors follow RFC 9457 Problem Details.
 */
import { z } from "zod";
import { RUN_KEY_PATTERN } from "./ingest";
import { Bbox, Finding, PredictedFinding } from "./traces";

export const CONTRACT_VERSION = 1;
export const CONTRACT_HEADER = "x-contract-version";

// --- RFC 9457 Problem Details ---
export const ProblemDetails = z.object({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Stable machine-readable code (extension member), e.g. `job_not_owner`. */
  code: z.string().optional(),
});
export type ProblemDetailsT = z.infer<typeof ProblemDetails>;

// --- Worker Registration ---
export const WorkerCapability = z.object({
  job: z.string(),
  versions: z.array(z.number().int()).default([1]),
  models: z.array(z.string()).optional(),
});
export type WorkerCapabilityT = z.infer<typeof WorkerCapability>;

export const RegisterWorkerRequest = z.object({
  name: z.string().min(1),
  runtime: z.enum(["local-gpu", "colab", "kaggle", "cloud"]),
  software: z
    .object({
      python: z.string().optional(),
      torch: z.string().optional(),
      cuda: z.string().optional(),
      vlmDentalCommit: z.string().optional(),
      // ADR-0024: upstream drift report. Provenance is recorded, never used to gate behaviour; the
      // job availability rows are what the probe measured on the worker's machine at registration.
      vlmDentalBranch: z.string().optional(),
      vlmDentalDirty: z.boolean().optional(),
      vlmDentalPath: z.string().optional(),
      packages: z.record(z.string(), z.string().nullable()).optional(),
      packageErrors: z.record(z.string(), z.string()).optional(),
      jobs: z
        .record(
          z.string(),
          z.object({
            available: z.boolean(),
            reason: z.string().nullable().optional(),
            warnings: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      tools: z.array(z.string()).optional(),
      unknownToApp: z.array(z.string()).optional(),
      missingUpstream: z.array(z.string()).optional(),
      groundingWeights: z.string().nullable().optional(),
      advertisedJobs: z.array(z.string()).optional(),
    })
    .default({}),
  capabilities: z.array(WorkerCapability).default([]),
});
export type RegisterWorkerRequestT = z.infer<typeof RegisterWorkerRequest>;

export const RegisterWorkerResponse = z.object({
  workerId: z.string().uuid(),
  pollIntervalMs: z.number().int().default(5000),
  leaseSeconds: z.number().int().default(60),
  serverTime: z.string(),
});
export type RegisterWorkerResponseT = z.infer<typeof RegisterWorkerResponse>;

// --- Heartbeat ---
export const HeartbeatRequest = z.object({
  workerId: z.string().uuid(),
  status: z.enum(["idle", "busy"]).default("idle"),
  load: z
    .object({
      gpuUtil: z.number().min(0).max(100).optional(),
      vramMb: z.number().min(0).optional(),
    })
    .optional(),
});
export type HeartbeatRequestT = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  cancelJobIds: z.array(z.string().uuid()).default([]),
});
export type HeartbeatResponseT = z.infer<typeof HeartbeatResponse>;

// --- Job Claim ---
export const ClaimJobsRequest = z.object({
  workerId: z.string().uuid(),
  accepts: z.array(z.string()),
  max: z.number().int().min(1).max(10).default(1),
  waitMs: z.number().int().min(0).max(20000).default(5000),
});
export type ClaimJobsRequestT = z.infer<typeof ClaimJobsRequest>;

export const ClaimedJob = z.object({
  id: z.string().uuid(),
  type: z.string(),
  version: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  attempt: z.number().int(),
  leaseExpiresAt: z.string(),
  idempotencyKey: z.string().nullable().optional(),
});
export type ClaimedJobT = z.infer<typeof ClaimedJob>;

export const ClaimJobsResponse = z.object({
  jobs: z.array(ClaimedJob),
});
export type ClaimJobsResponseT = z.infer<typeof ClaimJobsResponse>;

// --- Job Events (Streamed / Appended) ---
export const JobEvent = z.object({
  seq: z.number().int().min(1),
  type: z.enum(["progress", "log", "turn", "artifact", "partial"]),
  data: z.unknown(),
});
export type JobEventT = z.infer<typeof JobEvent>;

export const JobEventsRequest = z.object({
  events: z.array(JobEvent).min(1),
});
export type JobEventsRequestT = z.infer<typeof JobEventsRequest>;

export const JobEventsResponse = z.object({
  accepted: z.number().int(),
  leaseExtendedUntil: z.string(),
});
export type JobEventsResponseT = z.infer<typeof JobEventsResponse>;

// --- Artifact Presign ---
export const PresignArtifactRequest = z.object({
  name: z.string().min(1),
  mime: z.string(),
  bytes: z.number().int().min(0),
  sha256: z.string().length(64),
});
export type PresignArtifactRequestT = z.infer<typeof PresignArtifactRequest>;

export const PresignArtifactResponse = z.object({
  artifactId: z.string().uuid(),
  uploadUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});
export type PresignArtifactResponseT = z.infer<typeof PresignArtifactResponse>;

// --- Job Complete & Fail ---
export const CompleteJobRequest = z.object({
  result: z.unknown(),
  artifactIds: z.array(z.string().uuid()).default([]),
});
export type CompleteJobRequestT = z.infer<typeof CompleteJobRequest>;

export const CompleteJobResponse = z.object({
  ok: z.literal(true),
});

export const FailJobRequest = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().default(false),
  }),
});
export type FailJobRequestT = z.infer<typeof FailJobRequest>;

export const FailJobResponse = z.object({
  ok: z.literal(true),
  attemptsRemaining: z.number().int(),
});

// --- Specific Job Payloads and Results (§10.2) ---

// 1. yolo.prelabel
export const YoloPrelabelPayload = z.object({
  imageId: z.union([z.string().uuid(), z.number().int()]),
  modelId: z.string(),
  confThreshold: z.number().min(0).max(1).default(0.25),
});
export const YoloPrelabelResult = z.object({
  modelId: z.string(),
  inferenceMs: z.number(),
  boxes: z.array(
    z.object({
      bbox: Bbox,
      conf: z.number().min(0).max(1),
      classIdx: z.number().int().min(0).max(31),
      fdiQuadrant: z.number().int().min(1).max(4),
      fdiPosition: z.number().int().min(1).max(8),
    }),
  ),
});

// 2. tool.execute
export const ToolExecutePayload = z.object({
  imageId: z.union([z.string().uuid(), z.number().int()]),
  tool: z.enum([
    "zoom_crop",
    "window_level",
    "locate_tooth",
    "fdi_label",
    "denoise",
    "contralateral_compare",
    "enhance_contrast",
    "nudge_crop",
  ]),
  args: z.record(z.string(), z.unknown()),
  view: z.enum(["native", "canonical"]).default("native"),
});
export const ToolExecuteResult = z.object({
  kind: z.enum(["image", "data"]),
  data: z.unknown().optional(),
  artifactId: z.string().uuid().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number(),
});

// 3. agent.run
export const AgentRunPayload = z.object({
  imageId: z.union([z.string().uuid(), z.number().int()]),
  modelId: z.string(),
  mode: z.enum(["with_tools", "no_tools"]),
  maxTurns: z.number().int().default(30),
  maxToolCalls: z.number().int().default(50),
  canonicalResize: z.boolean().default(false),
  seed: z.number().int().optional(),
  /** Sampling temperature per turn. 0 (greedy) is the evaluation default and matches the SFT/GRPO loop. */
  temperature: z.number().min(0).max(2).default(0),
});

// 4. eval.run
export const EvalRunPayload = z.object({
  modelId: z.string(),
  dataset: z.string(),
  split: z.string().default("test"),
  canonicalResize: z.boolean().default(false),
  /**
   * App image ids (UUIDs) to evaluate. Integers are the research-repo's own vocabulary and stay
   * accepted by the schema, but a worker cannot resolve them to pixels: it refuses them with a reason
   * (ADR-0025 addendum §2). Omitted = evaluate the split via `GET /images`.
   */
  imageIds: z.array(z.union([z.string().uuid(), z.number().int()])).max(500).optional(),
  /** Dataset row whose images make up the run when `imageIds` is omitted. */
  datasetId: z.string().uuid().optional(),
  /** Cap when `imageIds` is omitted. The plan's >10-image gate applies: ask the owner first. */
  limit: z.number().int().min(1).max(500).optional(),
  /** Cohort the run used; the model that produced the numbers, not a paper arm. */
  mode: z.enum(["with_tools", "no_tools"]).default("with_tools"),
  maxTurns: z.number().int().default(30),
  maxToolCalls: z.number().int().default(50),
  seed: z.number().int().optional(),
  temperature: z.number().min(0).max(2).default(0),
  /** Recorded as `EvalCase.provider`; `local` for a backend this worker runs itself. */
  provider: z.string().trim().min(1).max(80).default("local"),
  /** Worker-chosen run identity; `POST /ingest/eval-run` upserts cases under it. Derived when absent. */
  runKey: z.string().regex(RUN_KEY_PATTERN).optional(),
});
export const EvalRunResult = z.object({
  runId: z.string().uuid(),
  n: z.number().int(),
  summary: z.record(z.string(), z.number()),
});

// 5. trace.render_artifacts
export const TraceRenderArtifactsPayload = z.object({
  traceId: z.string().uuid(),
});
export const TraceRenderArtifactsResult = z.object({
  artifacts: z.array(
    z.object({
      turnIdx: z.number().int(),
      callIdx: z.number().int(),
      artifactId: z.string().uuid(),
    }),
  ),
});

// 6. al.score
export const AlScorePayload = z.object({
  imageIds: z.array(z.union([z.string().uuid(), z.number().int()])),
  modelId: z.string(),
});
export const AlScoreResult = z.object({
  scores: z.array(
    z.object({
      imageId: z.union([z.string().uuid(), z.number().int()]),
      meanConf: z.number(),
      minConf: z.number(),
      entropy: z.number(),
      nBoxes: z.number().int(),
    }),
  ),
});

// 3b. agent.run result (streams one `turn` event per turn; event data = Turn, see traces.ts)
export const AgentRunResult = z.object({
  /** Tolerant class (ADR-0014): a model may put a full FDI code in `tooth_position`; that is kept, not rejected. */
  finalAnswer: z.array(PredictedFinding),
  nTurns: z.number().int().min(0),
  nToolCalls: z.number().int().min(0),
  formatOk: z.boolean(),
  /** The trace this run was stored as, when the worker could ingest one (ADR-0025). */
  traceId: z.string().uuid().optional(),
  rewardComponents: z
    .object({
      accuracy: z.number(),
      format: z.number(),
      toolValidity: z.number(),
      efficiency: z.number(),
    })
    .optional(),
});

/**
 * `GET /images/{id}` response (ADR-0025). The download URL and size were always here; a live run
 * also needs the image's identity and ground truth to post a trace. `groundTruth: null` means the
 * app does not know it, and the worker must skip ingestion rather than invent a healthy scan.
 */
export const ImageMetadataResponse = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  imageId: z.string().uuid(),
  sourceImageId: z.number().int(),
  datasetId: z.string().uuid(),
  /** Dataset source (`dentex` | `tufts` | `upload`), the key `/ingest/traces` resolves. */
  dataset: z.enum(["dentex", "tufts", "upload"]).nullable(),
  datasetName: z.string().nullable(),
  split: z.string().nullable(),
  /** Strict ground truth (`Finding[]`); `[]` is a healthy scan, `null` is unknown. */
  groundTruth: z.array(Finding).nullable(),
});

/**
 * `GET /images` (ADR-0025 addendum §2). Lets `eval.run` enumerate a split without a database.
 * Ordered by `sourceImageId`; `total` is the unpaged count for the same filter.
 */
export const ImageListResponse = z.object({
  images: z.array(
    z.object({
      id: z.string().uuid(),
      sourceImageId: z.number().int(),
      split: z.string().nullable(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ),
  total: z.number().int().min(0),
});
export type ImageListResponseT = z.infer<typeof ImageListResponse>;

/**
 * `GET /traces/{id}` (ADR-0025 addendum §2): only what re-executing the tool calls needs. Thoughts and
 * raw model output are deliberately absent — a worker has no use for them and they are the largest part
 * of a trace.
 */
export const WorkerTraceResponse = z.object({
  traceId: z.string().uuid(),
  imageId: z.string().uuid(),
  mode: z.enum(["with_tools", "no_tools"]),
  turns: z.array(
    z.object({
      idx: z.number().int().min(0),
      toolCalls: z.array(
        z.object({
          idx: z.number().int().min(0),
          toolName: z.string(),
          args: z.record(z.string(), z.unknown()),
          ok: z.boolean(),
          error: z.string().nullable(),
          /** The artifact this call already produced, when it produced one. */
          artifactId: z.string().uuid().nullable(),
        }),
      ),
    }),
  ),
});
export type WorkerTraceResponseT = z.infer<typeof WorkerTraceResponse>;

// 7. system.ping — contract-level diagnostic (not in plan §10.2). Lets an operator
// verify the whole pipe (enqueue → claim → events → complete → SSE) with no GPU.
export const SystemPingPayload = z.object({
  message: z.string().max(200).default("ping"),
  /** Number of progress events the worker should emit before completing. */
  steps: z.number().int().min(0).max(20).default(3),
});
export const SystemPingResult = z.object({
  echo: z.string(),
  workerName: z.string(),
  steps: z.number().int().min(0),
});

/** Header carrying the calling worker's id on job-write endpoints (ownership fence). */
export const WORKER_ID_HEADER = "x-worker-id";
