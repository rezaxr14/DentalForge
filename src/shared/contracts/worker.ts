/**
 * Worker Contract v1 (Plan §10)
 *
 * Base path: `/api/worker/v1`
 * Auth: `Authorization: Bearer tf_wrk_<token>` (stored hashed, scoped to one org)
 * Header: `X-Contract-Version: 1` required; errors follow RFC 9457 Problem Details.
 */
import { z } from "zod";
import { Bbox, Finding } from "./traces";

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
});

// 4. eval.run
export const EvalRunPayload = z.object({
  modelId: z.string(),
  dataset: z.string(),
  split: z.string().default("test"),
  canonicalResize: z.boolean().default(false),
  imageIds: z.array(z.number().int()).optional(),
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
  finalAnswer: z.array(Finding),
  nTurns: z.number().int().min(0),
  nToolCalls: z.number().int().min(0),
  formatOk: z.boolean(),
  rewardComponents: z
    .object({
      accuracy: z.number(),
      format: z.number(),
      toolValidity: z.number(),
      efficiency: z.number(),
    })
    .optional(),
});

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
