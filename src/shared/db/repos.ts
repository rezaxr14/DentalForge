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
import type { Annotation, AnnotationStatus } from "../contracts/labels";
import type { Role } from "../domain/auth";
import type { Command } from "../domain/editing/history";
import type { SetTransition } from "../domain/editing/persist";

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
  /** Optional so older constructors (fixtures, createTrace callers) stay valid. */
  verifierReason?: string | null;
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
  /** Set only for runs created through `ingest/eval-run` (ADR-0013); optional so older constructors stay valid. */
  runKey?: string | null;
  canonicalResize?: boolean;
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
  /** Model boxes keep their confidence and model (ADR-0019: the old record dropped both). */
  confidence: number | null;
  modelId: string | null;
  /** The id the editor uses for this box (`pred_1_3`, `new_...`); `id` is the internal UUID and never leaves the server. */
  clientId: string;
  /** Order inside the set (the editor's array order: Tab walk, undo re-insertion). */
  position: number;
}

/** Input of the legacy single-box insert: the new fields are optional so existing callers stay valid. */
export type NewAnnotation = Omit<AnnotationRecord, "id" | "orgId" | "updatedAt" | "clientId" | "position" | "confidence" | "modelId"> & {
  confidence?: number | null;
  modelId?: string | null;
};

export interface AnnotationSetRecord {
  id: string;
  orgId: string;
  imageId: string;
  assigneeId: string | null;
  state: AnnotationStatus;
  /** Optimistic-concurrency token: +1 per accepted op batch that changed something and per state transition. */
  version: number;
  submittedAt: Date | null;
}

/** How the editor names an image: the dataset source plus the number in the file name (`train_673.png` -> 673). */
export interface ImageSourceKey {
  source: DatasetRecord["source"];
  sourceImageId: number;
}

export interface OpenImageInput extends ImageSourceKey {
  datasetName: string;
  licenseNote?: string;
  contentHash: string;
  width: number;
  height: number;
  storageKey: string;
  split: string | null;
}

export interface AnnotationSetSnapshot {
  set: AnnotationSetRecord;
  image: ImageRecord;
  /** In editor order, with the editor's own ids. */
  annotations: Annotation[];
}

export type ApplyOpsOutcome =
  | { kind: "ok"; snapshot: AnnotationSetSnapshot }
  /** `version`: the batch was built on a stale set; `state`: the set is no longer a draft. Nothing was written. */
  | { kind: "conflict"; reason: "version" | "state"; snapshot: AnnotationSetSnapshot }
  | { kind: "invalid"; message: string }
  | { kind: "not_found" };

export type TransitionOutcome = ApplyOpsOutcome | { kind: "forbidden" };

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

/** A registered model checkpoint (plan §7 `model_registry`), unique per (org, name, stage). */
export interface ModelRecord {
  id: string;
  orgId: string;
  name: string;
  kind: "yolo" | "vlm" | "api";
  stage: "zero_shot" | "sft" | "grpo" | "yolo";
  hfPath: string | null;
  onnxArtifactId: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface RegisterModelInput {
  name: string;
  kind: ModelRecord["kind"];
  stage: ModelRecord["stage"];
  /** `undefined` = keep the stored value on a re-register. */
  hfPath?: string;
  onnxArtifactId?: string;
  meta?: Record<string, unknown>;
}

/** A training run (plan §7 `training_runs`), unique per (org, kind, name). */
export interface TrainingRunRecord {
  id: string;
  orgId: string;
  kind: "sft" | "grpo" | "yolo";
  name: string;
  config: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: Date;
}

export interface TrainingMetricRecord {
  runId: string;
  step: number;
  name: string;
  /** Postgres `real`: 32-bit precision (both stores round identically). */
  value: number;
}

export interface RewardSampleRecord {
  id: string;
  orgId: string;
  runId: string;
  step: number;
  trajectoryRef: string;
  components: Record<string, number>;
  total: number;
  createdAt: Date;
}

export interface IngestTrainingInput {
  run: { kind: TrainingRunRecord["kind"]; name: string; config?: Record<string, unknown>; status?: TrainingRunRecord["status"] };
  metrics: { step: number; name: string; value: number }[];
  rewardSamples: { step: number; trajectoryRef: string; components: Record<string, number>; total: number }[];
}

export interface IngestTrainingResult {
  run: TrainingRunRecord;
  runCreated: boolean;
  /** Rows that did not exist before; the remainder of the batch overwrote existing keys. */
  metricsInserted: number;
  rewardSamplesInserted: number;
}

export interface TraceToolCallInput {
  idx: number;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  trueBbox: unknown;
  perturbTier: string | null;
}

export interface TraceTurnInput {
  idx: number;
  status: string;
  thought: string | null;
  rawOutput: string | null;
  parsed: unknown;
  toolCalls: TraceToolCallInput[];
}

/** A trace turn with its tool calls nested, in (turn idx, call idx) order. */
export type TraceTurnRecord = Omit<TraceTurnInput, "toolCalls"> & {
  id: string;
  traceId: string;
  toolCalls: (TraceToolCallInput & { id: string })[];
};

export interface IngestTraceInput {
  datasetId: string;
  /** The dataset's own image number (`image_id` in the JSONL); resolved to an image row INSIDE the org. */
  sourceImageId: number;
  cohort: string;
  mode: TraceRecord["mode"];
  verified: boolean;
  sourceFile: string | null;
  contentHash: string;
  nTurns: number;
  nToolCalls: number;
  formatOk: boolean;
  verifierReason: string | null;
  groundTruth: unknown;
  finalAnswer: unknown;
  turns: TraceTurnInput[];
}

/**
 * `inserted`  new identity (dataset, image, cohort, mode): trace + turns + tool calls written atomically.
 * `existing`  identity already present: NOTHING is written (first import wins, ADR-0008);
 *             `sameContent` says whether the stored content hash equals this one.
 * `rejected`  the dataset or image is not in this organization.
 */
export type IngestTraceResult =
  | { outcome: "inserted" | "existing"; trace: TraceRecord; sameContent: boolean }
  | { outcome: "rejected"; reason: "unknown_dataset" | "unknown_image" };

/** One eval case as `ingest/eval-run` stores it (the same fields a file import stores, plus the two summarized metrics). */
export interface EvalCaseInput {
  /** The dataset's own image number; with the run it is the case's identity. */
  sourceImageId: number;
  groundTruth: unknown;
  predictions: unknown;
  matchedPairs: unknown;
  fdiF1: number;
  exactF1: number;
  closeness: number;
  spatial: number;
  diagSim: number;
  confidence: number | null;
  formatOk: boolean;
  rawOutput: string;
}

export interface EvalCaseRecord {
  id: string;
  runId: string;
  /** NULL for cases created by a file import. */
  sourceImageId: number | null;
  groundTruth: unknown;
  predictions: unknown;
  matchedPairs: unknown;
  fdiF1: number | null;
  exactF1: number | null;
  closeness: number | null;
  spatial: number | null;
  diagSim: number | null;
  confidence: number | null;
  formatOk: boolean | null;
  rawOutput: string | null;
}

export interface IngestEvalInput {
  /** Worker-chosen identity of the run within the organization. */
  runKey: string;
  run: { dataset: string; split: string; provider: string; model: string; canonicalResize: boolean };
  cases: EvalCaseInput[];
}

/**
 * `ok`           cases upserted; `run.n` and `run.summary` are recomputed from ALL stored cases of the run.
 * `run_mismatch` the key exists but with a different dataset/split/provider/model/canonicalResize: nothing written.
 */
export type IngestEvalResult =
  | { outcome: "ok"; run: EvalRunRecord; runCreated: boolean; casesInserted: number }
  | { outcome: "run_mismatch"; run: EvalRunRecord };

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
  createAnnotation(input: NewAnnotation): Promise<AnnotationRecord>;
  /**
   * LabelForge persistence (ADR-0019). All four are org-scoped like everything here and are implemented once per store
   * behind ONE shared test suite (tests/helpers/annotation-repo-suite.ts).
   *
   * `openAnnotationSet` registers the dataset/image on first use (idempotent) and creates the empty draft set;
   * `getAnnotationSet` never writes. `applyAnnotationOps` is atomic: a stale `baseVersion`, a non-draft set or any invalid op
   * leaves the stored set untouched. `transitionAnnotationSet` checks the role INSIDE the same critical section that
   * reads the authors, so "nobody decides their own work" cannot race with a concurrent edit.
   */
  openAnnotationSet(input: OpenImageInput & { assigneeId: string }): Promise<AnnotationSetSnapshot>;
  getAnnotationSet(key: ImageSourceKey): Promise<AnnotationSetSnapshot | null>;
  applyAnnotationOps(input: ImageSourceKey & { baseVersion: number; ops: Command[]; actorId: string }): Promise<ApplyOpsOutcome>;
  transitionAnnotationSet(
    input: ImageSourceKey & { baseVersion: number; transition: SetTransition; actorId: string; role: Role; reason?: string },
  ): Promise<TransitionOutcome>;
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

  /** Upsert by (org, name, stage); omitted optional fields keep their stored value. */
  registerModel(input: RegisterModelInput): Promise<{ model: ModelRecord; created: boolean }>;
  listModels(): Promise<ModelRecord[]>;

  /**
   * ONE atomic write: upsert the run by (org, kind, name) — status never moves backwards —
   * then upsert metrics by (run, step, name) and reward samples by (run, step, trajectoryRef).
   * Re-sending a batch is a no-op in effect (idempotent); duplicate keys INSIDE a batch are the
   * caller's bug (the HTTP contract rejects them) and make this throw.
   */
  ingestTraining(input: IngestTrainingInput): Promise<IngestTrainingResult>;
  listTrainingRuns(): Promise<TrainingRunRecord[]>;
  /** Ordered by (step, name). Empty when the run is unknown OR belongs to another org. */
  listTrainingMetrics(runId: string): Promise<TrainingMetricRecord[]>;
  /** Ordered by (step, trajectoryRef). Empty when the run is unknown OR belongs to another org. */
  listRewardSamples(runId: string): Promise<RewardSampleRecord[]>;

  /**
   * Insert one verified trace with its turns and tool calls in ONE atomic step, deduplicated by
   * IDENTITY (dataset, image, cohort, mode) — never by content hash alone (ADR-0008). The dataset and
   * image are resolved inside this organization, so a caller can never attach a trace to another tenant's image.
   */
  ingestTrace(input: IngestTraceInput): Promise<IngestTraceResult>;
  /** Empty when the trace is unknown OR belongs to another org. */
  listTraceTurns(traceId: string): Promise<TraceTurnRecord[]>;

  /**
   * ONE atomic write: upsert the run by (org, runKey), upsert the cases by (run, sourceImageId), then recompute
   * `n` and `summary` from every stored case of the run with `summarizeEval` (the importer's own function).
   * Re-sending a chunk is a no-op in effect. Duplicate sourceImageIds INSIDE a chunk are the caller's bug and throw.
   */
  ingestEvalCases(input: IngestEvalInput): Promise<IngestEvalResult>;
  /** Ordered by source image number (NULLs last). Empty when the run is unknown OR belongs to another org. */
  listEvalCases(runId: string): Promise<EvalCaseRecord[]>;
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
