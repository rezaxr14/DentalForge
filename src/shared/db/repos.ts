/**
 * Repository layer (plan §5.2).
 *
 * ALL business-data access goes through `scoped(orgId)`. Repositories never
 * see another org's rows: the in-memory implementation partitions by org, and
 * the Drizzle implementation (M7, `db.pg.ts`) adds `eq(orgId)` to every
 * query. Direct `db.select()` in features is lint-forbidden.
 *
 * Cross-tenant isolation suite: tests/m6-platform.test.ts.
 */
import { z } from "zod";

export const OrgId = z.string().min(1);
export type OrgId = z.infer<typeof OrgId>;

export interface OrgRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface MembershipRecord {
  userId: string;
  orgId: string;
  role: "admin" | "annotator" | "reviewer";
}

export interface DatasetRecord {
  id: string;
  orgId: string;
  name: string;
  source: "dentex" | "tufts" | "upload";
  licenseNote: string | null;
  createdAt: Date;
}

export interface ImageRecord {
  id: string;
  orgId: string;
  datasetId: string;
  sourceImageId: number;
  contentHash: string;
  width: number;
  height: number;
  storageKey: string;
  split: string | null;
}

export interface TraceRecord {
  id: string;
  orgId: string;
  datasetId: string;
  imageId: string;
  cohort: string;
  mode: "with_tools" | "no_tools";
  verified: boolean;
  sourceFile: string | null;
  contentHash: string;
  nTurns: number;
  nToolCalls: number;
  formatOk: boolean;
  groundTruth: unknown;
  finalAnswer: unknown;
}

export interface EvalRunRecord {
  id: string;
  orgId: string;
  dataset: string;
  split: string;
  provider: string;
  model: string;
  n: number;
  summary: Record<string, number>;
  createdAt: Date;
}

export interface AnnotationRecord {
  id: string;
  orgId: string;
  imageId: string;
  setId: string | null;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  fdiQuadrant: number;
  fdiPosition: number;
  pathology: string;
  source: "gt_import" | "model" | "human";
  status: "draft" | "submitted" | "approved" | "rejected";
  version: number;
  authorId: string | null;
  updatedAt: Date;
}

export interface AuditRecord {
  id: string;
  orgId: string;
  actorId: string | null;
  action: string;
  resource: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Invite link record (plan §7 `invites` + our signed-link extension).
 * Custom open links (`tf_inv_…`, shared/lib/invites.ts) persist here with
 * `email: ""`; Better Auth email invitations share the table with a real
 * address. `tokenHash` is sha256 so a DB dump cannot mint memberships.
 */
export interface InviteRecord {
  id: string;
  orgId: string;
  email: string;
  role: "admin" | "annotator" | "reviewer";
  status: "pending" | "accepted" | "rejected" | "canceled";
  tokenHash: string | null;
  expiresAt: Date | null;
  maxUses: number;
  uses: number;
  inviterId: string | null;
}

export interface WorkerRecord {
  id: string;
  orgId: string;
  name: string;
  runtime: string;
  software: Record<string, unknown>;
  capabilities: string[];
  status: "online" | "degraded" | "offline";
  lastHeartbeatAt: Date | null;
  createdAt: Date;
}

export interface JobRecord {
  id: string;
  orgId: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  status: "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  priority: number;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: Date | null;
  claimedBy: string | null;
  idempotencyKey: string | null;
  result: unknown | null;
  error: unknown | null;
  /** Artifacts attached by the worker on completion (validated to be this org's). */
  artifactIds: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobEventRecord {
  jobId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: Date;
}

export interface WorkerTokenRecord {
  id: string;
  orgId: string;
  name: string;
  tokenHash: string;
  /** `jobs:read` (images/status) < `jobs:write` (claim/events/complete) < `admin`. */
  scopes: "jobs:read" | "jobs:write" | "admin";
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ArtifactRecord {
  id: string;
  orgId: string;
  kind: "tool_image" | "agent_image" | "report" | "model" | "export";
  storageKey: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  sha256: string | null;
  provenance: "worker_exact" | "browser_approx" | "import_replay";
  createdAt: Date;
}

/**
 * Why a worker-side job write was refused. Expected conditions are DATA, not
 * exceptions (plan §9.4 rule 2): the route layer maps each to a problem+json.
 *   not_found  job id unknown in this org
 *   not_owner  another worker holds the lease, or the lease was reaped and the
 *              job requeued — the caller must stop working on it
 *   cancelled  an operator cancelled the job
 *   terminal   already succeeded/failed/expired (and not an idempotent replay)
 */
export type JobWriteFailure = "not_found" | "not_owner" | "cancelled" | "terminal";
export type JobWrite<T> = { ok: true; value: T } | { ok: false; code: JobWriteFailure };

/**
 * The single ownership/terminal gate for worker-side job writes. Both store
 * implementations call this so the rules cannot drift:
 *   cancelled → `cancelled`; succeeded/failed/expired → `terminal`;
 *   queued (lease reaped) or leased to another worker → `not_owner`.
 */
export function gateJobWrite(job: JobRecord | null, workerId: string): JobWrite<JobRecord> {
  if (!job) return { ok: false, code: "not_found" };
  if (job.status === "cancelled") return { ok: false, code: "cancelled" };
  if (job.status === "succeeded" || job.status === "failed" || job.status === "expired") {
    return { ok: false, code: "terminal" };
  }
  if (job.status === "queued" || job.claimedBy !== workerId) return { ok: false, code: "not_owner" };
  return { ok: true, value: job };
}

/** Queued jobs nobody picks up expire after this long (plan §9.4 rule 6). */
export const DEFAULT_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Scoped repository surface — one org's view of the world. */
export interface ScopedRepos {
  readonly orgId: string;
  listDatasets(): Promise<DatasetRecord[]>;
  createDataset(input: { name: string; source: DatasetRecord["source"]; licenseNote?: string }): Promise<DatasetRecord>;
  listImages(datasetId: string): Promise<ImageRecord[]>;
  createImage(input: Omit<ImageRecord, "id" | "orgId">): Promise<ImageRecord>;
  listTraces(filter?: { datasetId?: string; mode?: TraceRecord["mode"] }): Promise<TraceRecord[]>;
  createTrace(input: Omit<TraceRecord, "id" | "orgId">): Promise<TraceRecord>;
  listEvalRuns(): Promise<EvalRunRecord[]>;
  createEvalRun(input: Omit<EvalRunRecord, "id" | "orgId" | "createdAt">): Promise<EvalRunRecord>;
  listAnnotations(imageId: string): Promise<AnnotationRecord[]>;
  createAnnotation(input: Omit<AnnotationRecord, "id" | "orgId" | "updatedAt">): Promise<AnnotationRecord>;
  appendAudit(input: { actorId: string | null; action: string; resource?: string; meta?: Record<string, unknown> }): Promise<AuditRecord>;
  listAudit(): Promise<AuditRecord[]>;
  /**
   * Invite links (custom signed-link flow: `tf_inv_…` + max_uses/uses).
   * `createInvite` persists the hash; `consumeInvite` atomically increments
   * `uses` iff the invite is still live (pending, unexpired, uses < maxUses)
   * and returns the updated record, or null when it cannot be consumed.
   */
  createInvite(input: Omit<InviteRecord, "id">): Promise<InviteRecord>;
  consumeInvite(tokenHash: string): Promise<InviteRecord | null>;
  getInviteByHash(tokenHash: string): Promise<InviteRecord | null>;

  // ---- Workers & Jobs (plan §10) -------------------------------------------

  /** Upsert by (org, name): a restarted worker re-attaches to its own row. */
  registerWorker(input: { name: string; runtime: string; software?: Record<string, unknown>; capabilities?: string[] }): Promise<WorkerRecord>;
  /** Stamp liveness; null if the worker is unknown in this org. */
  heartbeatWorker(workerId: string): Promise<WorkerRecord | null>;
  getWorker(workerId: string): Promise<WorkerRecord | null>;
  listWorkers(): Promise<WorkerRecord[]>;

  /** Idempotent on `idempotencyKey` (per org): a replay returns the original job. */
  createJob(input: { type: string; version?: number; payload: Record<string, unknown>; priority?: number; idempotencyKey?: string | null; createdBy?: string | null }): Promise<JobRecord>;
  /**
   * Lazy lease reaping (no cron — Vercel Hobby cron is daily only). Called by
   * the service on claim/heartbeat/read paths:
   *   claimed|running with an expired lease → back to `queued` (attempts left)
   *                                          or `expired` (attempts exhausted)
   *   queued longer than `queueTtlMs`       → `expired`
   */
  reapJobs(opts?: { queueTtlMs?: number }): Promise<{ requeued: number; expired: number }>;
  /**
   * Atomically lease up to `max` queued jobs of the accepted types (highest
   * priority, then oldest). Postgres: single statement with FOR UPDATE SKIP
   * LOCKED, so concurrent workers never receive the same job.
   */
  claimJobs(workerId: string, accepts: string[], max: number, leaseSeconds: number): Promise<JobRecord[]>;
  getJob(jobId: string): Promise<JobRecord | null>;
  listJobs(filter?: { status?: JobRecord["status"]; type?: string; limit?: number }): Promise<JobRecord[]>;
  /**
   * Append worker events, idempotent on (job, seq): a re-sent batch inserts
   * nothing new. Extends the lease and moves `claimed` → `running`.
   */
  appendJobEvents(jobId: string, workerId: string, events: { seq: number; type: string; data: unknown }[], leaseSeconds: number): Promise<JobWrite<{ accepted: number; leaseExpiresAt: Date | null }>>;
  listJobEvents(jobId: string, afterSeq?: number, limit?: number): Promise<JobEventRecord[]>;
  /** Idempotent for the owning worker: completing an already-succeeded job is ok. */
  completeJob(jobId: string, workerId: string, result: unknown, artifactIds: string[]): Promise<JobWrite<JobRecord>>;
  /** Retryable failure with attempts left → requeued; otherwise `failed`. */
  failJob(jobId: string, workerId: string, error: { code: string; message: string; retryable?: boolean }): Promise<JobWrite<{ job: JobRecord; attemptsRemaining: number }>>;
  /** Operator cancel: queued/claimed/running → `cancelled`; terminal jobs unchanged. */
  cancelJob(jobId: string): Promise<JobRecord | null>;
  /**
   * Heartbeat lease renewal: extend the lease of every job this worker still
   * holds (claimed/running) so a long job with no events is not reaped and
   * re-run while its worker is alive. Returns how many leases were renewed.
   */
  renewLeases(workerId: string, leaseSeconds: number): Promise<number>;
  /** Jobs this worker holds that were cancelled recently (heartbeat `cancelJobIds`). */
  cancelledJobIdsFor(workerId: string, sinceMs?: number): Promise<string[]>;

  createArtifact(input: Omit<ArtifactRecord, "id" | "orgId" | "createdAt">): Promise<ArtifactRecord>;
  /** Only this org's artifacts come back; callers compare lengths to detect foreign ids. */
  getArtifacts(ids: string[]): Promise<ArtifactRecord[]>;
  getImage(imageId: string): Promise<ImageRecord | null>;

  createWorkerToken(input: { name: string; tokenHash: string; scopes?: WorkerTokenRecord["scopes"] }): Promise<WorkerTokenRecord>;
  getWorkerTokenByHash(tokenHash: string): Promise<WorkerTokenRecord | null>;
  listWorkerTokens(): Promise<WorkerTokenRecord[]>;
  revokeWorkerToken(tokenId: string): Promise<boolean>;
}

/** Top-level store: orgs, memberships, and the `scoped()` entry point. */
export interface OrgStore {
  createOrg(input: { slug: string; name: string }): Promise<OrgRecord>;
  getOrgBySlug(slug: string): Promise<OrgRecord | null>;
  addMember(input: { userId: string; orgId: string; role: MembershipRecord["role"] }): Promise<MembershipRecord>;
  membership(userId: string, orgId: string): Promise<MembershipRecord | null>;
  scoped(orgId: string): ScopedRepos;
  findOrgByWorkerTokenHash(tokenHash: string): Promise<{ org: OrgRecord; token: WorkerTokenRecord } | null>;
}
