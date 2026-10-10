import type { JobDtoT, JobEventDtoT } from "@/shared/contracts/jobs";
import type { ClaimedJobT } from "@/shared/contracts/worker";
import type { JobEventRecord, JobRecord } from "@/shared/db/repos";

export function toJobDto(j: JobRecord): JobDtoT {
  return {
    id: j.id,
    type: j.type,
    version: j.version,
    status: j.status,
    priority: j.priority,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    payload: (j.payload ?? {}) as Record<string, unknown>,
    result: j.result ?? null,
    error: j.error ?? null,
    artifactIds: j.artifactIds ?? [],
    claimedBy: j.claimedBy,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function toEventDto(e: JobEventRecord): JobEventDtoT {
  return { seq: e.seq, type: e.type, data: e.data ?? null, createdAt: e.createdAt.toISOString() };
}

export function toClaimedJob(j: JobRecord): ClaimedJobT {
  return {
    id: j.id,
    type: j.type,
    version: j.version,
    payload: (j.payload ?? {}) as Record<string, unknown>,
    attempt: j.attempts,
    leaseExpiresAt: (j.leaseExpiresAt ?? new Date()).toISOString(),
    idempotencyKey: j.idempotencyKey,
  };
}
