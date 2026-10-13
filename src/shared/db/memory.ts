/**
 * In-memory OrgStore — dev/test stand-in for the Drizzle implementation.
 *
 * Partitions every collection by orgId, so the cross-tenant isolation suite
 * (tests/m6-platform.test.ts) proves the `scoped()` contract before Postgres
 * lands. Not for production: no persistence, no concurrency control.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_QUEUE_TTL_MS,
  gateJobWrite,
  type AnnotationRecord,
  type ArtifactRecord,
  type AuditRecord,
  type DatasetRecord,
  type EvalRunRecord,
  type ImageRecord,
  type EvalCaseRecord,
  type IngestEvalInput,
  type IngestEvalResult,
  type IngestTraceInput,
  type IngestTraceResult,
  type IngestTrainingInput,
  type IngestTrainingResult,
  type InviteRecord,
  type JobEventRecord,
  type JobRecord,
  type JobWrite,
  type MembershipRecord,
  type ModelRecord,
  type OrgRecord,
  type OrgStore,
  type RegisterModelInput,
  type RewardSampleRecord,
  type ScopedRepos,
  type TraceRecord,
  type TraceTurnRecord,
  type TrainingMetricRecord,
  type TrainingRunRecord,
  type WorkerRecord,
  type WorkerTokenRecord,
} from "./repos";
import { mergeRunStatus, toFloat4 } from "./ingest-rules";
import { summarizeEval } from "@/shared/lib/import/parse";

function uid(): string {
  return randomUUID();
}

/** Code-unit order == Postgres `COLLATE "C"` for the ASCII names the contract carries; keeps both stores' list order identical. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNoDuplicates(keys: string[], what: string): void {
  if (new Set(keys).size !== keys.length) throw new Error(`duplicate ${what} keys inside one batch`);
}

class ScopedMemory implements ScopedRepos {
  constructor(
    readonly orgId: string,
    private readonly root: MemoryStore,
  ) {}

  private assertOrg(id: string): void {
    if (id !== this.orgId) throw new Error("cross-tenant access blocked");
  }

  async listDatasets(): Promise<DatasetRecord[]> {
    return [...this.root.datasets.values()].filter((d) => d.orgId === this.orgId);
  }

  async createDataset(input: { name: string; source: DatasetRecord["source"]; licenseNote?: string }): Promise<DatasetRecord> {
    const rec: DatasetRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      source: input.source,
      licenseNote: input.licenseNote ?? null,
      createdAt: new Date(),
    };
    this.root.datasets.set(rec.id, rec);
    return rec;
  }

  async listImages(datasetId: string): Promise<ImageRecord[]> {
    const ds = this.root.datasets.get(datasetId);
    if (!ds || ds.orgId !== this.orgId) return [];
    return [...this.root.images.values()].filter((i) => i.datasetId === datasetId && i.orgId === this.orgId);
  }

  async createImage(input: Omit<ImageRecord, "id" | "orgId">): Promise<ImageRecord> {
    const ds = this.root.datasets.get(input.datasetId);
    if (!ds || ds.orgId !== this.orgId) throw new Error("dataset not found in org");
    const rec: ImageRecord = { ...input, id: uid(), orgId: this.orgId };
    this.root.images.set(rec.id, rec);
    return rec;
  }

  async listTraces(filter?: { datasetId?: string; mode?: TraceRecord["mode"] }): Promise<TraceRecord[]> {
    return [...this.root.traces.values()].filter(
      (t) =>
        t.orgId === this.orgId &&
        (filter?.datasetId === undefined || t.datasetId === filter.datasetId) &&
        (filter?.mode === undefined || t.mode === filter.mode),
    );
  }

  async createTrace(input: Omit<TraceRecord, "id" | "orgId">): Promise<TraceRecord> {
    this.assertOrg(this.root.datasets.get(input.datasetId)?.orgId ?? this.orgId);
    const rec: TraceRecord = { ...input, id: uid(), orgId: this.orgId };
    this.root.traces.set(rec.id, rec);
    return rec;
  }

  async listEvalRuns(): Promise<EvalRunRecord[]> {
    return [...this.root.evalRuns.values()].filter((r) => r.orgId === this.orgId);
  }

  async createEvalRun(input: Omit<EvalRunRecord, "id" | "orgId" | "createdAt">): Promise<EvalRunRecord> {
    const rec: EvalRunRecord = { ...input, id: uid(), orgId: this.orgId, createdAt: new Date() };
    this.root.evalRuns.set(rec.id, rec);
    return rec;
  }

  async listAnnotations(imageId: string): Promise<AnnotationRecord[]> {
    const img = this.root.images.get(imageId);
    if (!img || img.orgId !== this.orgId) return [];
    return [...this.root.annotations.values()].filter((a) => a.imageId === imageId && a.orgId === this.orgId);
  }

  async createAnnotation(input: Omit<AnnotationRecord, "id" | "orgId" | "updatedAt">): Promise<AnnotationRecord> {
    const img = this.root.images.get(input.imageId);
    if (!img || img.orgId !== this.orgId) throw new Error("image not found in org");
    const rec: AnnotationRecord = { ...input, id: uid(), orgId: this.orgId, updatedAt: new Date() };
    this.root.annotations.set(rec.id, rec);
    return rec;
  }

  async appendAudit(input: {
    actorId: string | null;
    action: string;
    resource?: string;
    meta?: Record<string, unknown>;
  }): Promise<AuditRecord> {
    const rec: AuditRecord = {
      id: uid(),
      orgId: this.orgId,
      actorId: input.actorId,
      action: input.action,
      resource: input.resource ?? null,
      meta: input.meta ?? {},
      createdAt: new Date(),
    };
    this.root.audit.set(rec.id, rec);
    return rec;
  }

  async listAudit(): Promise<AuditRecord[]> {
    return [...this.root.audit.values()].filter((a) => a.orgId === this.orgId);
  }

  async createInvite(input: Omit<InviteRecord, "id">): Promise<InviteRecord> {
    if (input.orgId !== this.orgId) throw new Error("cross-tenant access blocked");
    const rec: InviteRecord = { ...input, id: uid() };
    this.root.invites.set(rec.id, rec);
    return rec;
  }

  async getInviteByHash(tokenHash: string): Promise<InviteRecord | null> {
    for (const inv of this.root.invites.values()) {
      if (inv.orgId === this.orgId && inv.tokenHash === tokenHash) return inv;
    }
    return null;
  }

  async consumeInvite(tokenHash: string): Promise<InviteRecord | null> {
    const inv = await this.getInviteByHash(tokenHash);
    if (!inv) return null;
    if (inv.status !== "pending") return null;
    if (inv.uses >= inv.maxUses) return null;
    if (inv.expiresAt !== null && inv.expiresAt.getTime() <= Date.now()) return null;
    inv.uses += 1;
    if (inv.uses >= inv.maxUses) inv.status = "accepted";
    this.root.invites.set(inv.id, inv);
    return inv;
  }

  // ---- Workers & Jobs (plan §10) -------------------------------------------
  // Semantics mirror the Drizzle implementation 1:1; both run the shared
  // contract suite in tests/m8-jobs-repo.test.ts.

  private orgJobs(): JobRecord[] {
    return [...this.root.jobs.values()].filter((j) => j.orgId === this.orgId);
  }

  private ownJob(jobId: string): JobRecord | null {
    const j = this.root.jobs.get(jobId);
    return j && j.orgId === this.orgId ? j : null;
  }

  async registerWorker(input: {
    name: string;
    runtime: string;
    software?: Record<string, unknown>;
    capabilities?: string[];
  }): Promise<WorkerRecord> {
    const now = new Date();
    const existing = [...this.root.workers.values()].find(
      (w) => w.orgId === this.orgId && w.name === input.name,
    );
    if (existing) {
      existing.runtime = input.runtime;
      existing.software = input.software ?? {};
      existing.capabilities = input.capabilities ?? [];
      existing.status = "online";
      existing.lastHeartbeatAt = now;
      return { ...existing };
    }
    const rec: WorkerRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      runtime: input.runtime,
      software: input.software ?? {},
      capabilities: input.capabilities ?? [],
      status: "online",
      lastHeartbeatAt: now,
      createdAt: now,
    };
    this.root.workers.set(rec.id, rec);
    return { ...rec };
  }

  async heartbeatWorker(workerId: string): Promise<WorkerRecord | null> {
    const w = this.root.workers.get(workerId);
    if (!w || w.orgId !== this.orgId) return null;
    w.status = "online";
    w.lastHeartbeatAt = new Date();
    return { ...w };
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    const w = this.root.workers.get(workerId);
    return w && w.orgId === this.orgId ? { ...w } : null;
  }

  async listWorkers(): Promise<WorkerRecord[]> {
    return [...this.root.workers.values()]
      .filter((w) => w.orgId === this.orgId)
      .map((w) => ({ ...w }));
  }

  async createJob(input: {
    type: string;
    version?: number;
    payload: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string | null;
    createdBy?: string | null;
  }): Promise<JobRecord> {
    if (input.idempotencyKey) {
      const existing = this.orgJobs().find((j) => j.idempotencyKey === input.idempotencyKey);
      if (existing) return { ...existing };
    }
    const now = new Date();
    const rec: JobRecord = {
      id: uid(),
      orgId: this.orgId,
      type: input.type,
      version: input.version ?? 1,
      payload: input.payload,
      status: "queued",
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: 3,
      leaseExpiresAt: null,
      claimedBy: null,
      idempotencyKey: input.idempotencyKey ?? null,
      result: null,
      error: null,
      artifactIds: [],
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.root.jobs.set(rec.id, rec);
    return { ...rec };
  }

  async reapJobs(opts?: { queueTtlMs?: number }): Promise<{ requeued: number; expired: number }> {
    const ttl = opts?.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS;
    const now = Date.now();
    let requeued = 0;
    let expired = 0;
    for (const job of this.orgJobs()) {
      const leased = job.status === "claimed" || job.status === "running";
      if (leased && job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() <= now) {
        if (job.attempts >= job.maxAttempts) {
          job.status = "expired";
          job.error = { code: "lease_expired", message: "worker lease expired and attempts are exhausted" };
          job.leaseExpiresAt = null;
          expired += 1;
        } else {
          job.status = "queued";
          job.claimedBy = null;
          job.leaseExpiresAt = null;
          requeued += 1;
        }
        job.updatedAt = new Date();
      } else if (job.status === "queued" && now - job.createdAt.getTime() > ttl) {
        job.status = "expired";
        job.error = { code: "queue_timeout", message: "no worker picked this job up in time" };
        job.updatedAt = new Date();
        expired += 1;
      }
    }
    return { requeued, expired };
  }

  async claimJobs(
    workerId: string,
    accepts: string[],
    max: number,
    leaseSeconds: number,
  ): Promise<JobRecord[]> {
    const now = Date.now();
    const picked = this.orgJobs()
      .filter((j) => j.status === "queued" && accepts.includes(j.type) && j.attempts < j.maxAttempts)
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, Math.max(0, max));
    for (const job of picked) {
      job.status = "claimed";
      job.claimedBy = workerId;
      job.attempts += 1;
      job.leaseExpiresAt = new Date(now + leaseSeconds * 1000);
      job.updatedAt = new Date();
    }
    return picked.map((j) => ({ ...j }));
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const j = this.ownJob(jobId);
    return j ? { ...j } : null;
  }

  async listJobs(filter?: {
    status?: JobRecord["status"];
    type?: string;
    limit?: number;
  }): Promise<JobRecord[]> {
    return this.orgJobs()
      .filter((j) => (filter?.status ? j.status === filter.status : true))
      .filter((j) => (filter?.type ? j.type === filter.type : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter?.limit ?? 50)
      .map((j) => ({ ...j }));
  }

  async appendJobEvents(
    jobId: string,
    workerId: string,
    events: { seq: number; type: string; data: unknown }[],
    leaseSeconds: number,
  ): Promise<JobWrite<{ accepted: number; leaseExpiresAt: Date | null }>> {
    const g = gateJobWrite(this.ownJob(jobId), workerId);
    if (!g.ok) return g;
    const job = g.value;
    const list = this.root.jobEvents.get(jobId) ?? [];
    const have = new Set(list.map((e) => e.seq));
    let accepted = 0;
    for (const e of events) {
      if (have.has(e.seq)) continue; // idempotent re-send
      have.add(e.seq);
      list.push({ jobId, seq: e.seq, type: e.type, data: e.data, createdAt: new Date() });
      accepted += 1;
    }
    this.root.jobEvents.set(jobId, list);
    job.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
    if (job.status === "claimed") job.status = "running";
    job.updatedAt = new Date();
    return { ok: true, value: { accepted, leaseExpiresAt: job.leaseExpiresAt } };
  }

  async listJobEvents(jobId: string, afterSeq = 0, limit = 500): Promise<JobEventRecord[]> {
    if (!this.ownJob(jobId)) return [];
    return (this.root.jobEvents.get(jobId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async completeJob(
    jobId: string,
    workerId: string,
    result: unknown,
    artifactIds: string[],
  ): Promise<JobWrite<JobRecord>> {
    const job = this.ownJob(jobId);
    // Idempotent replay: the owner completing an already-succeeded job is fine.
    if (job && job.status === "succeeded" && job.claimedBy === workerId) {
      return { ok: true, value: { ...job } };
    }
    const g = gateJobWrite(job, workerId);
    if (!g.ok) return g;
    g.value.status = "succeeded";
    g.value.result = result;
    g.value.artifactIds = [...artifactIds];
    g.value.error = null;
    g.value.leaseExpiresAt = null;
    g.value.updatedAt = new Date();
    return { ok: true, value: { ...g.value } };
  }

  async failJob(
    jobId: string,
    workerId: string,
    error: { code: string; message: string; retryable?: boolean },
  ): Promise<JobWrite<{ job: JobRecord; attemptsRemaining: number }>> {
    const job = this.ownJob(jobId);
    if (job && job.status === "failed" && job.claimedBy === workerId) {
      return { ok: true, value: { job: { ...job }, attemptsRemaining: 0 } };
    }
    const g = gateJobWrite(job, workerId);
    if (!g.ok) return g;
    const j = g.value;
    const remaining = Math.max(0, j.maxAttempts - j.attempts);
    const requeue = (error.retryable ?? false) && remaining > 0;
    if (requeue) {
      j.status = "queued";
      j.claimedBy = null;
    } else {
      j.status = "failed";
    }
    j.leaseExpiresAt = null;
    j.error = error;
    j.updatedAt = new Date();
    return { ok: true, value: { job: { ...j }, attemptsRemaining: requeue ? remaining : 0 } };
  }

  async cancelJob(jobId: string): Promise<JobRecord | null> {
    const job = this.ownJob(jobId);
    if (!job) return null;
    if (job.status === "queued" || job.status === "claimed" || job.status === "running") {
      job.status = "cancelled";
      job.leaseExpiresAt = null;
      job.updatedAt = new Date();
    }
    return { ...job };
  }

  async renewLeases(workerId: string, leaseSeconds: number): Promise<number> {
    let n = 0;
    for (const job of this.orgJobs()) {
      if ((job.status === "claimed" || job.status === "running") && job.claimedBy === workerId) {
        job.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
        job.updatedAt = new Date();
        n += 1;
      }
    }
    return n;
  }

  async cancelledJobIdsFor(workerId: string, sinceMs = 10 * 60 * 1000): Promise<string[]> {
    const cutoff = Date.now() - sinceMs;
    return this.orgJobs()
      .filter((j) => j.status === "cancelled" && j.claimedBy === workerId && j.updatedAt.getTime() >= cutoff)
      .map((j) => j.id);
  }

  async createArtifact(input: Omit<ArtifactRecord, "id" | "orgId" | "createdAt">): Promise<ArtifactRecord> {
    const rec: ArtifactRecord = { ...input, id: uid(), orgId: this.orgId, createdAt: new Date() };
    this.root.artifacts.set(rec.id, rec);
    return { ...rec };
  }

  async getArtifacts(ids: string[]): Promise<ArtifactRecord[]> {
    const out: ArtifactRecord[] = [];
    for (const id of new Set(ids)) {
      const a = this.root.artifacts.get(id);
      if (a && a.orgId === this.orgId) out.push({ ...a });
    }
    return out;
  }

  async getImage(imageId: string): Promise<ImageRecord | null> {
    const img = this.root.images.get(imageId);
    return img && img.orgId === this.orgId ? { ...img } : null;
  }

  async createWorkerToken(input: {
    name: string;
    tokenHash: string;
    scopes?: WorkerTokenRecord["scopes"];
  }): Promise<WorkerTokenRecord> {
    const rec: WorkerTokenRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      tokenHash: input.tokenHash,
      scopes: input.scopes ?? "jobs:write",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.root.workerTokens.set(rec.id, rec);
    return { ...rec };
  }

  async getWorkerTokenByHash(tokenHash: string): Promise<WorkerTokenRecord | null> {
    const t = [...this.root.workerTokens.values()].find(
      (tok) => tok.orgId === this.orgId && tok.tokenHash === tokenHash && !tok.revokedAt,
    );
    return t ? { ...t } : null;
  }

  async listWorkerTokens(): Promise<WorkerTokenRecord[]> {
    return [...this.root.workerTokens.values()]
      .filter((t) => t.orgId === this.orgId)
      .map((t) => ({ ...t }));
  }

  async revokeWorkerToken(tokenId: string): Promise<boolean> {
    const t = this.root.workerTokens.get(tokenId);
    if (!t || t.orgId !== this.orgId || t.revokedAt) return false;
    t.revokedAt = new Date();
    return true;
  }

  async registerModel(input: RegisterModelInput): Promise<{ model: ModelRecord; created: boolean }> {
    const existing = [...this.root.models.values()].find(
      (m) => m.orgId === this.orgId && m.name === input.name && m.stage === input.stage,
    );
    if (existing) {
      existing.kind = input.kind;
      if (input.hfPath !== undefined) existing.hfPath = input.hfPath;
      if (input.onnxArtifactId !== undefined) existing.onnxArtifactId = input.onnxArtifactId;
      if (input.meta !== undefined) existing.meta = structuredClone(input.meta);
      return { model: structuredClone(existing), created: false };
    }
    const rec: ModelRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      kind: input.kind,
      stage: input.stage,
      hfPath: input.hfPath ?? null,
      onnxArtifactId: input.onnxArtifactId ?? null,
      meta: structuredClone(input.meta ?? {}),
      createdAt: new Date(),
    };
    this.root.models.set(rec.id, rec);
    return { model: structuredClone(rec), created: true };
  }

  async listModels(): Promise<ModelRecord[]> {
    return [...this.root.models.values()]
      .filter((m) => m.orgId === this.orgId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.name, b.name))
      .map((m) => structuredClone(m));
  }

  async ingestTraining(input: IngestTrainingInput): Promise<IngestTrainingResult> {
    // Validate first, mutate after: the whole call is atomic (all or nothing), like the SQL transaction.
    assertNoDuplicates(input.metrics.map((m) => `${m.step}\u0000${m.name}`), "metric");
    assertNoDuplicates(input.rewardSamples.map((r) => `${r.step}\u0000${r.trajectoryRef}`), "reward sample");

    let run = [...this.root.trainingRuns.values()].find(
      (r) => r.orgId === this.orgId && r.kind === input.run.kind && r.name === input.run.name,
    );
    const runCreated = run === undefined;
    if (!run) {
      run = {
        id: uid(),
        orgId: this.orgId,
        kind: input.run.kind,
        name: input.run.name,
        config: structuredClone(input.run.config ?? {}),
        status: input.run.status ?? "running",
        createdAt: new Date(),
      };
      this.root.trainingRuns.set(run.id, run);
    } else {
      if (input.run.config !== undefined) run.config = structuredClone(input.run.config);
      run.status = mergeRunStatus(run.status, input.run.status);
    }

    let metricsInserted = 0;
    for (const m of input.metrics) {
      const key = `${run.id}\u0000${m.step}\u0000${m.name}`;
      if (!this.root.trainingMetrics.has(key)) metricsInserted++;
      this.root.trainingMetrics.set(key, { runId: run.id, step: m.step, name: m.name, value: toFloat4(m.value) });
    }
    let rewardSamplesInserted = 0;
    for (const r of input.rewardSamples) {
      const key = `${run.id}\u0000${r.step}\u0000${r.trajectoryRef}`;
      const prior = this.root.rewardSamples.get(key);
      if (!prior) rewardSamplesInserted++;
      this.root.rewardSamples.set(key, {
        id: prior?.id ?? uid(),
        orgId: this.orgId,
        runId: run.id,
        step: r.step,
        trajectoryRef: r.trajectoryRef,
        components: structuredClone(r.components),
        total: toFloat4(r.total),
        createdAt: prior?.createdAt ?? new Date(),
      });
    }
    return { run: structuredClone(run), runCreated, metricsInserted, rewardSamplesInserted };
  }

  async listTrainingRuns(): Promise<TrainingRunRecord[]> {
    return [...this.root.trainingRuns.values()]
      .filter((r) => r.orgId === this.orgId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.name, b.name))
      .map((r) => structuredClone(r));
  }

  private ownsRun(runId: string): boolean {
    return this.root.trainingRuns.get(runId)?.orgId === this.orgId;
  }

  async listTrainingMetrics(runId: string): Promise<TrainingMetricRecord[]> {
    if (!this.ownsRun(runId)) return [];
    return [...this.root.trainingMetrics.values()]
      .filter((m) => m.runId === runId)
      .sort((a, b) => a.step - b.step || cmp(a.name, b.name))
      .map((m) => ({ ...m }));
  }

  async listRewardSamples(runId: string): Promise<RewardSampleRecord[]> {
    if (!this.ownsRun(runId)) return [];
    return [...this.root.rewardSamples.values()]
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.step - b.step || cmp(a.trajectoryRef, b.trajectoryRef))
      .map((r) => structuredClone(r));
  }

  async ingestTrace(input: IngestTraceInput): Promise<IngestTraceResult> {
    // Mirrors the unique indexes trace_turns(trace, idx) and tool_calls(turn, idx): refuse before mutating anything.
    if (new Set(input.turns.map((t) => t.idx)).size !== input.turns.length) throw new Error("duplicate turn idx in one trace");
    if (input.turns.some((t) => new Set(t.toolCalls.map((c) => c.idx)).size !== t.toolCalls.length)) {
      throw new Error("duplicate tool call idx in one turn");
    }
    const dataset = this.root.datasets.get(input.datasetId);
    if (!dataset || dataset.orgId !== this.orgId) return { outcome: "rejected", reason: "unknown_dataset" };
    const image = [...this.root.images.values()].find(
      (i) => i.orgId === this.orgId && i.datasetId === input.datasetId && i.sourceImageId === input.sourceImageId,
    );
    if (!image) return { outcome: "rejected", reason: "unknown_image" };

    const existing = [...this.root.traces.values()].find(
      (t) =>
        t.orgId === this.orgId &&
        t.datasetId === input.datasetId &&
        t.imageId === image.id &&
        t.cohort === input.cohort &&
        t.mode === input.mode,
    );
    if (existing) {
      return { outcome: "existing", trace: structuredClone(existing), sameContent: existing.contentHash === input.contentHash };
    }
    const trace: TraceRecord = {
      id: uid(),
      orgId: this.orgId,
      datasetId: input.datasetId,
      imageId: image.id,
      cohort: input.cohort,
      mode: input.mode,
      verified: input.verified,
      sourceFile: input.sourceFile,
      contentHash: input.contentHash,
      nTurns: input.nTurns,
      nToolCalls: input.nToolCalls,
      formatOk: input.formatOk,
      verifierReason: input.verifierReason,
      groundTruth: structuredClone(input.groundTruth),
      finalAnswer: structuredClone(input.finalAnswer),
    };
    this.root.traces.set(trace.id, trace);
    this.root.traceTurns.set(
      trace.id,
      input.turns.map((t) => ({
        id: uid(),
        traceId: trace.id,
        idx: t.idx,
        status: t.status,
        thought: t.thought,
        rawOutput: t.rawOutput,
        parsed: structuredClone(t.parsed),
        toolCalls: t.toolCalls.map((c) => ({ ...structuredClone(c), id: uid() })),
      })),
    );
    return { outcome: "inserted", trace: structuredClone(trace), sameContent: true };
  }

  async listTraceTurns(traceId: string): Promise<TraceTurnRecord[]> {
    if (this.root.traces.get(traceId)?.orgId !== this.orgId) return [];
    return structuredClone(this.root.traceTurns.get(traceId) ?? [])
      .sort((a, b) => a.idx - b.idx)
      .map((t) => ({ ...t, toolCalls: [...t.toolCalls].sort((a, b) => a.idx - b.idx) }));
  }

  async ingestEvalCases(input: IngestEvalInput): Promise<IngestEvalResult> {
    assertNoDuplicates(input.cases.map((c) => String(c.sourceImageId)), "eval case");
    let run = [...this.root.evalRuns.values()].find((r) => r.orgId === this.orgId && r.runKey === input.runKey);
    const runCreated = run === undefined;
    if (run) {
      const m = input.run;
      if (run.dataset !== m.dataset || run.split !== m.split || run.provider !== m.provider || run.model !== m.model || (run.canonicalResize ?? false) !== m.canonicalResize) {
        return { outcome: "run_mismatch", run: structuredClone(run) };
      }
    } else {
      run = {
        id: uid(),
        orgId: this.orgId,
        dataset: input.run.dataset,
        split: input.run.split,
        provider: input.run.provider,
        model: input.run.model,
        canonicalResize: input.run.canonicalResize,
        n: 0,
        summary: {},
        runKey: input.runKey,
        createdAt: new Date(),
      };
      this.root.evalRuns.set(run.id, run);
    }

    let casesInserted = 0;
    for (const c of input.cases) {
      const key = `${run.id}\u0000${c.sourceImageId}`;
      const prior = this.root.evalCases.get(key);
      if (!prior) casesInserted++;
      this.root.evalCases.set(key, {
        id: prior?.id ?? uid(),
        runId: run.id,
        sourceImageId: c.sourceImageId,
        groundTruth: structuredClone(c.groundTruth),
        predictions: structuredClone(c.predictions),
        matchedPairs: structuredClone(c.matchedPairs),
        // real columns: round like Postgres so both stores summarize identical numbers
        fdiF1: toFloat4(c.fdiF1),
        exactF1: toFloat4(c.exactF1),
        closeness: toFloat4(c.closeness),
        spatial: toFloat4(c.spatial),
        diagSim: toFloat4(c.diagSim),
        confidence: c.confidence === null ? null : toFloat4(c.confidence),
        formatOk: c.formatOk,
        rawOutput: c.rawOutput,
      });
    }

    const stored = [...this.root.evalCases.values()]
      .filter((c) => c.runId === run.id)
      .sort((a, b) => (a.sourceImageId ?? 0) - (b.sourceImageId ?? 0));
    run.n = stored.length;
    run.summary = summarizeEval(
      stored.map((c) => ({
        fdiF1: c.fdiF1 ?? 0,
        exactF1: c.exactF1 ?? 0,
        closeness: c.closeness ?? 0,
        spatial: c.spatial ?? 0,
        diagSim: c.diagSim ?? 0,
        formatOk: c.formatOk ?? false,
      })),
    );
    return { outcome: "ok", run: structuredClone(run), runCreated, casesInserted };
  }

  async listEvalCases(runId: string): Promise<EvalCaseRecord[]> {
    if (this.root.evalRuns.get(runId)?.orgId !== this.orgId) return [];
    return [...this.root.evalCases.values()]
      .filter((c) => c.runId === runId)
      .sort((a, b) => (a.sourceImageId ?? Number.MAX_SAFE_INTEGER) - (b.sourceImageId ?? Number.MAX_SAFE_INTEGER))
      .map((c) => structuredClone(c));
  }
}

export class MemoryStore implements OrgStore {
  /**
   * Brand read by `isDegradedStore`. A property, not `instanceof`: the store selector is shared on
   * `globalThis` across route bundles, and each bundle may hold its own copy of this class, so
   * `instanceof` is false for a store created by another bundle.
   */
  readonly degraded = true as const;
  readonly orgs = new Map<string, OrgRecord>();
  readonly bySlug = new Map<string, string>();
  readonly members = new Map<string, MembershipRecord>();
  readonly datasets = new Map<string, DatasetRecord>();
  readonly images = new Map<string, ImageRecord>();
  readonly traces = new Map<string, TraceRecord>();
  readonly evalRuns = new Map<string, EvalRunRecord>();
  readonly annotations = new Map<string, AnnotationRecord>();
  readonly audit = new Map<string, AuditRecord>();
  readonly invites = new Map<string, InviteRecord>();
  readonly workers = new Map<string, WorkerRecord>();
  readonly jobs = new Map<string, JobRecord>();
  readonly jobEvents = new Map<string, JobEventRecord[]>();
  readonly workerTokens = new Map<string, WorkerTokenRecord>();
  readonly artifacts = new Map<string, ArtifactRecord>();
  readonly traceTurns = new Map<string, TraceTurnRecord[]>();
  readonly evalCases = new Map<string, EvalCaseRecord>();
  readonly models = new Map<string, ModelRecord>();
  readonly trainingRuns = new Map<string, TrainingRunRecord>();
  readonly trainingMetrics = new Map<string, TrainingMetricRecord>();
  readonly rewardSamples = new Map<string, RewardSampleRecord>();

  async createOrg(input: { slug: string; name: string }): Promise<OrgRecord> {
    if (this.bySlug.has(input.slug)) throw new Error(`org slug taken: ${input.slug}`);
    const rec: OrgRecord = { id: uid(), slug: input.slug, name: input.name, createdAt: new Date() };
    this.orgs.set(rec.id, rec);
    this.bySlug.set(input.slug, rec.id);
    return rec;
  }

  async getOrgBySlug(slug: string): Promise<OrgRecord | null> {
    const id = this.bySlug.get(slug);
    return id ? (this.orgs.get(id) ?? null) : null;
  }

  async addMember(input: { userId: string; orgId: string; role: MembershipRecord["role"] }): Promise<MembershipRecord> {
    if (!this.orgs.has(input.orgId)) throw new Error("org not found");
    const rec: MembershipRecord = { ...input };
    this.members.set(`${input.userId}:${input.orgId}`, rec);
    return rec;
  }

  async membership(userId: string, orgId: string): Promise<MembershipRecord | null> {
    return this.members.get(`${userId}:${orgId}`) ?? null;
  }

  scoped(orgId: string): ScopedRepos {
    if (!this.orgs.has(orgId)) throw new Error("org not found");
    return new ScopedMemory(orgId, this);
  }

  async findOrgByWorkerTokenHash(tokenHash: string): Promise<{ org: OrgRecord; token: WorkerTokenRecord } | null> {
    const tok = [...this.workerTokens.values()].find((t) => t.tokenHash === tokenHash && !t.revokedAt);
    if (!tok) return null;
    const org = this.orgs.get(tok.orgId);
    if (!org) return null;
    tok.lastUsedAt = new Date();
    return { org, token: { ...tok } };
  }
}
