/**
 * In-memory OrgStore — dev/test stand-in for the Drizzle implementation.
 *
 * Partitions every collection by orgId, so the cross-tenant isolation suite
 * (tests/m6-platform.test.ts) proves the `scoped()` contract before Postgres
 * lands. Not for production: no persistence, no concurrency control.
 */
import { randomUUID } from "node:crypto";
import {
  AnnotationRecord,
  AuditRecord,
  DatasetRecord,
  EvalRunRecord,
  ImageRecord,
  InviteRecord,
  MembershipRecord,
  OrgRecord,
  OrgStore,
  ScopedRepos,
  TraceRecord,
} from "./repos";

function uid(): string {
  return randomUUID();
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

  // Workers & Jobs (Plan §10)
  async registerWorker(input: {
    name: string;
    runtime: string;
    software?: Record<string, unknown>;
    capabilities?: string[];
  }): Promise<WorkerRecord> {
    const rec: WorkerRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      runtime: input.runtime,
      software: input.software ?? {},
      capabilities: input.capabilities ?? [],
      status: "online",
      lastHeartbeatAt: new Date(),
      createdAt: new Date(),
    };
    this.root.workers.set(rec.id, rec);
    return rec;
  }

  async heartbeatWorker(
    workerId: string,
    status: "online" | "degraded" | "offline" = "online",
  ): Promise<WorkerRecord | null> {
    const w = this.root.workers.get(workerId);
    if (!w || w.orgId !== this.orgId) return null;
    w.status = status;
    w.lastHeartbeatAt = new Date();
    this.root.workers.set(workerId, w);
    return w;
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    const w = this.root.workers.get(workerId);
    return w && w.orgId === this.orgId ? w : null;
  }

  async listWorkers(): Promise<WorkerRecord[]> {
    return [...this.root.workers.values()].filter((w) => w.orgId === this.orgId);
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
      const existing = [...this.root.jobs.values()].find(
        (j) => j.orgId === this.orgId && j.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return existing;
    }
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
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.root.jobs.set(rec.id, rec);
    return rec;
  }

  async claimJobs(
    workerId: string,
    accepts: string[],
    max = 1,
    leaseSeconds = 60,
  ): Promise<JobRecord[]> {
    const now = Date.now();
    const candidates = [...this.root.jobs.values()]
      .filter((j) => {
        if (j.orgId !== this.orgId) return false;
        if (!accepts.includes(j.type)) return false;
        if (j.status === "queued") return true;
        if (
          j.status === "claimed" &&
          j.leaseExpiresAt &&
          j.leaseExpiresAt.getTime() < now &&
          j.attempts < j.maxAttempts
        ) {
          return true;
        }
        return false;
      })
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, max);

    const claimed: JobRecord[] = [];
    for (const job of candidates) {
      job.status = "claimed";
      job.claimedBy = workerId;
      job.attempts += 1;
      job.leaseExpiresAt = new Date(now + leaseSeconds * 1000);
      job.updatedAt = new Date();
      this.root.jobs.set(job.id, job);
      claimed.push(job);
    }
    return claimed;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const j = this.root.jobs.get(jobId);
    return j && j.orgId === this.orgId ? j : null;
  }

  async appendJobEvents(
    jobId: string,
    events: { seq: number; type: string; data: unknown }[],
    leaseSeconds = 60,
  ): Promise<{ accepted: number; leaseExpiresAt: Date | null }> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error("job not found");

    const list = this.root.jobEvents.get(jobId) ?? [];
    for (const e of events) {
      list.push({
        jobId,
        seq: e.seq,
        type: e.type,
        data: e.data,
        createdAt: new Date(),
      });
    }
    this.root.jobEvents.set(jobId, list);

    job.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
    job.updatedAt = new Date();
    this.root.jobs.set(job.id, job);

    return { accepted: events.length, leaseExpiresAt: job.leaseExpiresAt };
  }

  async listJobEvents(jobId: string, afterSeq = 0): Promise<JobEventRecord[]> {
    const job = await this.getJob(jobId);
    if (!job) return [];
    const list = this.root.jobEvents.get(jobId) ?? [];
    return list.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  async completeJob(jobId: string, result: unknown): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job) return null;
    job.status = "succeeded";
    job.result = result;
    job.updatedAt = new Date();
    this.root.jobs.set(jobId, job);
    return job;
  }

  async failJob(
    jobId: string,
    error: { code: string; message: string; retryable?: boolean },
  ): Promise<{ job: JobRecord | null; attemptsRemaining: number }> {
    const job = await this.getJob(jobId);
    if (!job) return { job: null, attemptsRemaining: 0 };

    const retryable = error.retryable ?? false;
    const attemptsRemaining = Math.max(0, job.maxAttempts - job.attempts);

    if (retryable && attemptsRemaining > 0) {
      job.status = "queued";
      job.claimedBy = null;
      job.leaseExpiresAt = null;
    } else {
      job.status = "failed";
    }

    job.error = error;
    job.updatedAt = new Date();
    this.root.jobs.set(jobId, job);
    return { job, attemptsRemaining };
  }

  async createWorkerToken(input: {
    name: string;
    tokenHash: string;
    scopes?: string;
  }): Promise<WorkerTokenRecord> {
    const rec: WorkerTokenRecord = {
      id: uid(),
      orgId: this.orgId,
      name: input.name,
      tokenHash: input.tokenHash,
      scopes: input.scopes ?? "jobs:read",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.root.workerTokens.set(rec.id, rec);
    return rec;
  }

  async getWorkerTokenByHash(tokenHash: string): Promise<WorkerTokenRecord | null> {
    const t = [...this.root.workerTokens.values()].find(
      (tok) => tok.orgId === this.orgId && tok.tokenHash === tokenHash && !tok.revokedAt,
    );
    return t ?? null;
  }
}

export class MemoryStore implements OrgStore {
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
    return org ? { org, token: tok } : null;
  }
}
