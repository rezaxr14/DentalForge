/**
 * Job-type registry + user-facing DTOs (plan §10.2).
 *
 * One table maps every job type to its payload and result schema, so the
 * enqueue path (payload) and the worker `complete` path (result) validate
 * against the same source of truth. Unknown types are rejected at enqueue.
 */
import { z } from "zod";
import {
  AgentRunPayload,
  AgentRunResult,
  AlScorePayload,
  AlScoreResult,
  EvalRunPayload,
  EvalRunResult,
  SystemPingPayload,
  SystemPingResult,
  ToolExecutePayload,
  ToolExecuteResult,
  TraceRenderArtifactsPayload,
  TraceRenderArtifactsResult,
  YoloPrelabelPayload,
  YoloPrelabelResult,
} from "./worker";

export const JOB_DEFINITIONS = {
  "system.ping": { payload: SystemPingPayload, result: SystemPingResult },
  "yolo.prelabel": { payload: YoloPrelabelPayload, result: YoloPrelabelResult },
  "tool.execute": { payload: ToolExecutePayload, result: ToolExecuteResult },
  "agent.run": { payload: AgentRunPayload, result: AgentRunResult },
  "eval.run": { payload: EvalRunPayload, result: EvalRunResult },
  "trace.render_artifacts": { payload: TraceRenderArtifactsPayload, result: TraceRenderArtifactsResult },
  "al.score": { payload: AlScorePayload, result: AlScoreResult },
} as const;

export type JobTypeName = keyof typeof JOB_DEFINITIONS;
export const JOB_TYPE_NAMES = Object.keys(JOB_DEFINITIONS) as [JobTypeName, ...JobTypeName[]];

export function isJobType(name: string): name is JobTypeName {
  return Object.prototype.hasOwnProperty.call(JOB_DEFINITIONS, name);
}

/** User-facing enqueue request (POST /api/jobs). */
export const CreateJobRequest = z.object({
  type: z.enum(JOB_TYPE_NAMES),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(0).max(10).default(0),
});
export type CreateJobRequestT = z.infer<typeof CreateJobRequest>;

export const JobStatus = z.enum(["queued", "claimed", "running", "succeeded", "failed", "cancelled", "expired"]);
export type JobStatusT = z.infer<typeof JobStatus>;
export const TERMINAL_STATUSES: ReadonlySet<JobStatusT> = new Set(["succeeded", "failed", "cancelled", "expired"]);

export const JobDto = z.object({
  id: z.string(),
  type: z.string(),
  version: z.number().int(),
  status: JobStatus,
  priority: z.number().int(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  result: z.unknown().nullable(),
  error: z.unknown().nullable(),
  artifactIds: z.array(z.string()),
  claimedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobDtoT = z.infer<typeof JobDto>;

export const JobEventDto = z.object({
  seq: z.number().int(),
  type: z.string(),
  data: z.unknown(),
  createdAt: z.string(),
});
export type JobEventDtoT = z.infer<typeof JobEventDto>;

/** Polling fallback response for GET /api/jobs/:id/events?format=json. */
export const JobEventsPage = z.object({
  job: JobDto,
  events: z.array(JobEventDto),
  nextAfter: z.number().int(),
  done: z.boolean(),
});
export type JobEventsPageT = z.infer<typeof JobEventsPage>;

/** Validate + normalize a payload (applies schema defaults) for a known job type. */
export function parsePayload(
  type: JobTypeName,
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] } {
  const r = JOB_DEFINITIONS[type].payload.safeParse(payload);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  return { ok: true, value: r.data as Record<string, unknown> };
}

/** Validate a worker-submitted result for a known job type. Unknown types pass through. */
export function parseResult(
  type: string,
  result: unknown,
): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  if (!isJobType(type)) return { ok: true, value: result };
  const r = JOB_DEFINITIONS[type].result.safeParse(result);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  return { ok: true, value: r.data };
}

/** Artifact ids a result refers to (so a worker cannot smuggle another org's id into a result). */
export function artifactRefsInResult(type: string, result: unknown): string[] {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return [];
  if (type === "tool.execute" && typeof r.artifactId === "string") return [r.artifactId];
  if (type === "trace.render_artifacts" && Array.isArray(r.artifacts)) {
    return r.artifacts
      .map((a) => (a as { artifactId?: unknown }).artifactId)
      .filter((x): x is string => typeof x === "string");
  }
  return [];
}
