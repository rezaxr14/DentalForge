/**
 * Drizzle (Postgres) implementation of the OrgStore contract (plan §5.2).
 *
 * Every query is pinned to `orgId` — the `scoped(orgId)` boundary is enforced
 * at the SQL level (`eq(table.orgId, …)` on every read AND write), mirroring
 * the in-memory implementation (memory.ts) so the cross-tenant isolation
 * suite passes against both backends:
 *   - tests/m6-platform.test.ts      (memory)
 *   - tests/m6-repos.test.ts         (drizzle, requires Docker Postgres)
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./pg";
import {
  annotations,
  artifacts,
  auditLog,
  datasets,
  evalRuns,
  images,
  invites,
  jobEvents,
  jobs,
  memberships,
  organizations,
  traces,
  workerTokens,
  workers,
} from "./schema";
import {
  DEFAULT_QUEUE_TTL_MS,
  gateJobWrite,
  type AnnotationRecord,
  type ArtifactRecord,
  type AuditRecord,
  type DatasetRecord,
  type EvalRunRecord,
  type ImageRecord,
  type InviteRecord,
  type JobEventRecord,
  type JobRecord,
  type JobWrite,
  type MembershipRecord,
  type OrgRecord,
  type OrgStore,
  type ScopedRepos,
  type TraceRecord,
  type WorkerRecord,
  type WorkerTokenRecord,
} from "./repos";

/** Map a raw `invites` row to the InviteRecord contract (org_id alias). */
function toInvite(row: typeof invites.$inferSelect): InviteRecord {
  return {
    id: row.id,
    orgId: row.organizationId,
    email: row.email,
    role: row.role,
    status: row.status,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    uses: row.uses,
    inviterId: row.inviterId,
  };
}

const toJob = (r: typeof jobs.$inferSelect): JobRecord => ({
  ...r,
  result: r.result ?? null,
  error: r.error ?? null,
});

const toWorkerToken = (r: typeof workerTokens.$inferSelect): WorkerTokenRecord => ({ ...r });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

class ScopedPg implements ScopedRepos {
  constructor(
    readonly orgId: string,
    private readonly db: Db,
  ) {}

  /** Dataset must exist inside THIS org or reads return empty / writes throw. */
  private datasetInOrg(datasetId: string) {
    return this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), eq(datasets.orgId, this.orgId)))
      .limit(1);
  }

  async listDatasets(): Promise<DatasetRecord[]> {
    return this.db
      .select()
      .from(datasets)
      .where(eq(datasets.orgId, this.orgId))
      .orderBy(asc(datasets.createdAt));
  }

  async createDataset(input: {
    name: string;
    source: DatasetRecord["source"];
    licenseNote?: string;
  }): Promise<DatasetRecord> {
    const rows = await this.db
      .insert(datasets)
      .values({
        orgId: this.orgId,
        name: input.name,
        source: input.source,
        licenseNote: input.licenseNote ?? null,
      })
      .returning();
    return rows[0]!;
  }

  async listImages(datasetId: string): Promise<ImageRecord[]> {
    if (!(await this.datasetInOrg(datasetId)).length) return [];
    return this.db
      .select()
      .from(images)
      .where(and(eq(images.datasetId, datasetId), eq(images.orgId, this.orgId)))
      .orderBy(asc(images.createdAt));
  }

  async createImage(input: Omit<ImageRecord, "id" | "orgId">): Promise<ImageRecord> {
    if (!(await this.datasetInOrg(input.datasetId)).length) {
      throw new Error("dataset not found in org");
    }
    const rows = await this.db
      .insert(images)
      .values({ ...input, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  async listTraces(filter?: {
    datasetId?: string;
    mode?: TraceRecord["mode"];
  }): Promise<TraceRecord[]> {
    const conds = [eq(traces.orgId, this.orgId)];
    if (filter?.datasetId !== undefined) conds.push(eq(traces.datasetId, filter.datasetId));
    if (filter?.mode !== undefined) conds.push(eq(traces.mode, filter.mode));
    return this.db
      .select()
      .from(traces)
      .where(and(...conds))
      .orderBy(asc(traces.createdAt));
  }

  async createTrace(input: Omit<TraceRecord, "id" | "orgId">): Promise<TraceRecord> {
    if (!(await this.datasetInOrg(input.datasetId)).length) {
      throw new Error("dataset not found in org");
    }
    const rows = await this.db
      .insert(traces)
      .values({ ...input, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  async listEvalRuns(): Promise<EvalRunRecord[]> {
    return this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.orgId, this.orgId))
      .orderBy(asc(evalRuns.createdAt));
  }

  async createEvalRun(
    input: Omit<EvalRunRecord, "id" | "orgId" | "createdAt">,
  ): Promise<EvalRunRecord> {
    const rows = await this.db
      .insert(evalRuns)
      .values({ ...input, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  async listAnnotations(imageId: string): Promise<AnnotationRecord[]> {
    return this.db
      .select()
      .from(annotations)
      .where(and(eq(annotations.imageId, imageId), eq(annotations.orgId, this.orgId)))
      .orderBy(asc(annotations.createdAt));
  }

  async createAnnotation(
    input: Omit<AnnotationRecord, "id" | "orgId" | "updatedAt">,
  ): Promise<AnnotationRecord> {
    const img = await this.db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.id, input.imageId), eq(images.orgId, this.orgId)))
      .limit(1);
    if (!img.length) throw new Error("image not found in org");
    const rows = await this.db
      .insert(annotations)
      .values({ ...input, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  async appendAudit(input: {
    actorId: string | null;
    action: string;
    resource?: string;
    meta?: Record<string, unknown>;
  }): Promise<AuditRecord> {
    const rows = await this.db
      .insert(auditLog)
      .values({
        orgId: this.orgId,
        actorId: input.actorId,
        action: input.action,
        resource: input.resource ?? null,
        meta: input.meta ?? {},
      })
      .returning();
    return rows[0]!;
  }

  async listAudit(): Promise<AuditRecord[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, this.orgId))
      .orderBy(asc(auditLog.createdAt));
  }

  async createInvite(input: Omit<InviteRecord, "id">): Promise<InviteRecord> {
    if (input.orgId !== this.orgId) throw new Error("cross-tenant access blocked");
    const rows = await this.db
      .insert(invites)
      .values({
        organizationId: this.orgId,
        email: input.email,
        role: input.role,
        status: input.status,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        uses: input.uses,
        inviterId: input.inviterId,
      })
      .returning();
    return toInvite(rows[0]!);
  }

  async getInviteByHash(tokenHash: string): Promise<InviteRecord | null> {
    const rows = await this.db
      .select()
      .from(invites)
      .where(and(eq(invites.organizationId, this.orgId), eq(invites.tokenHash, tokenHash)))
      .limit(1);
    const row = rows[0];
    return row ? toInvite(row) : null;
  }

  /**
   * Atomic single-statement consume: increments `uses` (and flips to
   * `accepted` at maxUses) only when the row is still live, then returns it.
   * Concurrent accept clicks race safely — only live rows match the WHERE.
   */
  async consumeInvite(tokenHash: string): Promise<InviteRecord | null> {
    const rows = await this.db
      .update(invites)
      .set({
        uses: sql`${invites.uses} + 1`,
        status: sql`CASE WHEN ${invites.uses} + 1 >= ${invites.maxUses} THEN 'accepted'::text ELSE ${invites.status} END` as unknown as InviteRecord["status"],
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invites.organizationId, this.orgId),
          eq(invites.tokenHash, tokenHash),
          eq(invites.status, "pending"),
          lte(invites.uses, sql`${invites.maxUses} - 1`),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toInvite(row) : null;
  }

  // ---- Workers & Jobs (plan §10) -------------------------------------------
  // All time comparisons use the DATABASE clock (now()), never the app clock,
  // so leases stay consistent across serverless instances with skewed clocks.

  async registerWorker(input: {
    name: string;
    runtime: string;
    software?: Record<string, unknown>;
    capabilities?: string[];
  }): Promise<WorkerRecord> {
    const rows = await this.db
      .insert(workers)
      .values({
        orgId: this.orgId,
        name: input.name,
        runtime: input.runtime,
        software: input.software ?? {},
        capabilities: input.capabilities ?? [],
        status: "online",
        lastHeartbeatAt: sql`now()` as unknown as Date,
      })
      .onConflictDoUpdate({
        target: [workers.orgId, workers.name],
        set: {
          runtime: input.runtime,
          software: input.software ?? {},
          capabilities: input.capabilities ?? [],
          status: "online",
          lastHeartbeatAt: sql`now()` as unknown as Date,
        },
      })
      .returning();
    return rows[0]!;
  }

  async heartbeatWorker(workerId: string): Promise<WorkerRecord | null> {
    const rows = await this.db
      .update(workers)
      .set({ status: "online", lastHeartbeatAt: sql`now()` as unknown as Date })
      .where(and(eq(workers.id, workerId), eq(workers.orgId, this.orgId)))
      .returning();
    return rows[0] ?? null;
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.orgId, this.orgId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listWorkers(): Promise<WorkerRecord[]> {
    return this.db
      .select()
      .from(workers)
      .where(eq(workers.orgId, this.orgId))
      .orderBy(asc(workers.createdAt));
  }

  async createJob(input: {
    type: string;
    version?: number;
    payload: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string | null;
    createdBy?: string | null;
  }): Promise<JobRecord> {
    const rows = await this.db
      .insert(jobs)
      .values({
        orgId: this.orgId,
        type: input.type,
        version: input.version ?? 1,
        payload: input.payload,
        priority: input.priority ?? 0,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing({ target: [jobs.orgId, jobs.idempotencyKey] })
      .returning();
    if (rows[0]) return toJob(rows[0]);
    // Idempotent replay: conflict on (org, key) → hand back the original job.
    const existing = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.orgId, this.orgId), eq(jobs.idempotencyKey, input.idempotencyKey ?? "")))
      .limit(1);
    return toJob(existing[0]!);
  }

  async reapJobs(opts?: { queueTtlMs?: number }): Promise<{ requeued: number; expired: number }> {
    const ttlSecs = (opts?.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS) / 1000;
    const leased = and(
      eq(jobs.orgId, this.orgId),
      or(eq(jobs.status, "claimed"), eq(jobs.status, "running")),
      sql`${jobs.leaseExpiresAt} <= now()`,
    );
    const exhausted = await this.db
      .update(jobs)
      .set({
        status: "expired",
        leaseExpiresAt: null,
        error: { code: "lease_expired", message: "worker lease expired and attempts are exhausted" },
        updatedAt: sql`now()` as unknown as Date,
      })
      .where(and(leased, sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
      .returning({ id: jobs.id });
    const requeued = await this.db
      .update(jobs)
      .set({ status: "queued", claimedBy: null, leaseExpiresAt: null, updatedAt: sql`now()` as unknown as Date })
      .where(and(leased, sql`${jobs.attempts} < ${jobs.maxAttempts}`))
      .returning({ id: jobs.id });
    const stale = await this.db
      .update(jobs)
      .set({
        status: "expired",
        error: { code: "queue_timeout", message: "no worker picked this job up in time" },
        updatedAt: sql`now()` as unknown as Date,
      })
      .where(
        and(
          eq(jobs.orgId, this.orgId),
          eq(jobs.status, "queued"),
          sql`${jobs.createdAt} < now() - make_interval(secs => ${ttlSecs}::float8)`,
        ),
      )
      .returning({ id: jobs.id });
    return { requeued: requeued.length, expired: exhausted.length + stale.length };
  }

  async claimJobs(
    workerId: string,
    accepts: string[],
    max: number,
    leaseSeconds: number,
  ): Promise<JobRecord[]> {
    if (accepts.length === 0 || max <= 0) return [];
    // One transaction: FOR UPDATE SKIP LOCKED locks the picked rows until the
    // UPDATE commits, so concurrent workers never lease the same job.
    const claimed = await this.db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.orgId, this.orgId),
            eq(jobs.status, "queued"),
            inArray(jobs.type, accepts),
            sql`${jobs.attempts} < ${jobs.maxAttempts}`,
          ),
        )
        .orderBy(desc(jobs.priority), asc(jobs.createdAt))
        .limit(max)
        .for("update", { skipLocked: true });
      if (picked.length === 0) return [];
      return tx
        .update(jobs)
        .set({
          status: "claimed",
          claimedBy: workerId,
          attempts: sql`${jobs.attempts} + 1`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds}::float8)` as unknown as Date,
          updatedAt: sql`now()` as unknown as Date,
        })
        .where(
          inArray(
            jobs.id,
            picked.map((p) => p.id),
          ),
        )
        .returning();
    });
    return claimed
      .map(toJob)
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, this.orgId)))
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async listJobs(filter?: {
    status?: JobRecord["status"];
    type?: string;
    limit?: number;
  }): Promise<JobRecord[]> {
    const conds = [eq(jobs.orgId, this.orgId)];
    if (filter?.status) conds.push(eq(jobs.status, filter.status));
    if (filter?.type) conds.push(eq(jobs.type, filter.type));
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(desc(jobs.createdAt))
      .limit(filter?.limit ?? 50);
    return rows.map(toJob);
  }

  /** Lock the job row for the duration of a worker write, then gate it. */
  private async lockedGate(tx: Tx, jobId: string, workerId: string, replayStatus?: JobRecord["status"]) {
    const rows = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, this.orgId)))
      .limit(1)
      .for("update");
    const job = rows[0] ? toJob(rows[0]) : null;
    // Idempotent replay by the owner of an already-finished job.
    if (job && replayStatus && job.status === replayStatus && job.claimedBy === workerId) {
      return { replay: true as const, job };
    }
    return { replay: false as const, gate: gateJobWrite(job, workerId) };
  }

  async appendJobEvents(
    jobId: string,
    workerId: string,
    events: { seq: number; type: string; data: unknown }[],
    leaseSeconds: number,
  ): Promise<JobWrite<{ accepted: number; leaseExpiresAt: Date | null }>> {
    return this.db.transaction(async (tx) => {
      const g = await this.lockedGate(tx, jobId, workerId);
      if (g.replay) throw new Error("unreachable");
      if (!g.gate.ok) return g.gate;
      // Drizzle rejects an empty VALUES list; an empty batch just renews the lease.
      const inserted =
        events.length === 0
          ? []
          : await tx
              .insert(jobEvents)
              .values(events.map((e) => ({ jobId, seq: e.seq, type: e.type, data: e.data ?? {} })))
              .onConflictDoNothing({ target: [jobEvents.jobId, jobEvents.seq] })
              .returning({ seq: jobEvents.seq });
      const updated = await tx
        .update(jobs)
        .set({
          status: g.gate.value.status === "claimed" ? "running" : g.gate.value.status,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds}::float8)` as unknown as Date,
          updatedAt: sql`now()` as unknown as Date,
        })
        .where(eq(jobs.id, jobId))
        .returning({ leaseExpiresAt: jobs.leaseExpiresAt });
      return {
        ok: true as const,
        value: { accepted: inserted.length, leaseExpiresAt: updated[0]?.leaseExpiresAt ?? null },
      };
    });
  }

  async listJobEvents(jobId: string, afterSeq = 0, limit = 500): Promise<JobEventRecord[]> {
    if (!(await this.getJob(jobId))) return [];
    const rows = await this.db
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.seq, afterSeq)))
      .orderBy(asc(jobEvents.seq))
      .limit(limit);
    return rows;
  }

  async completeJob(
    jobId: string,
    workerId: string,
    result: unknown,
    artifactIds: string[],
  ): Promise<JobWrite<JobRecord>> {
    return this.db.transaction(async (tx) => {
      const g = await this.lockedGate(tx, jobId, workerId, "succeeded");
      if (g.replay) return { ok: true as const, value: g.job };
      if (!g.gate.ok) return g.gate;
      const rows = await tx
        .update(jobs)
        .set({
          status: "succeeded",
          result: result ?? null,
          artifactIds,
          error: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()` as unknown as Date,
        })
        .where(eq(jobs.id, jobId))
        .returning();
      return { ok: true as const, value: toJob(rows[0]!) };
    });
  }

  async failJob(
    jobId: string,
    workerId: string,
    error: { code: string; message: string; retryable?: boolean },
  ): Promise<JobWrite<{ job: JobRecord; attemptsRemaining: number }>> {
    return this.db.transaction(async (tx) => {
      const g = await this.lockedGate(tx, jobId, workerId, "failed");
      if (g.replay) return { ok: true as const, value: { job: g.job, attemptsRemaining: 0 } };
      if (!g.gate.ok) return g.gate;
      const job = g.gate.value;
      const remaining = Math.max(0, job.maxAttempts - job.attempts);
      const requeue = (error.retryable ?? false) && remaining > 0;
      const rows = await tx
        .update(jobs)
        .set({
          status: requeue ? "queued" : "failed",
          claimedBy: requeue ? null : job.claimedBy,
          leaseExpiresAt: null,
          error,
          updatedAt: sql`now()` as unknown as Date,
        })
        .where(eq(jobs.id, jobId))
        .returning();
      return {
        ok: true as const,
        value: { job: toJob(rows[0]!), attemptsRemaining: requeue ? remaining : 0 },
      };
    });
  }

  async cancelJob(jobId: string): Promise<JobRecord | null> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "cancelled", leaseExpiresAt: null, updatedAt: sql`now()` as unknown as Date })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.orgId, this.orgId),
          or(eq(jobs.status, "queued"), eq(jobs.status, "claimed"), eq(jobs.status, "running")),
        ),
      )
      .returning();
    if (rows[0]) return toJob(rows[0]);
    return this.getJob(jobId); // terminal (or unknown): unchanged
  }

  async renewLeases(workerId: string, leaseSeconds: number): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds}::float8)` as unknown as Date,
        updatedAt: sql`now()` as unknown as Date,
      })
      .where(
        and(
          eq(jobs.orgId, this.orgId),
          eq(jobs.claimedBy, workerId),
          or(eq(jobs.status, "claimed"), eq(jobs.status, "running")),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length;
  }

  async cancelledJobIdsFor(workerId: string, sinceMs = 10 * 60 * 1000): Promise<string[]> {
    const rows = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.orgId, this.orgId),
          eq(jobs.status, "cancelled"),
          eq(jobs.claimedBy, workerId),
          sql`${jobs.updatedAt} >= now() - make_interval(secs => ${sinceMs / 1000}::float8)`,
        ),
      );
    return rows.map((r) => r.id);
  }

  async createArtifact(input: Omit<ArtifactRecord, "id" | "orgId" | "createdAt">): Promise<ArtifactRecord> {
    const rows = await this.db
      .insert(artifacts)
      .values({ ...input, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  async getArtifacts(ids: string[]): Promise<ArtifactRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.orgId, this.orgId), inArray(artifacts.id, unique)));
  }

  async getImage(imageId: string): Promise<ImageRecord | null> {
    const rows = await this.db
      .select()
      .from(images)
      .where(and(eq(images.id, imageId), eq(images.orgId, this.orgId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async createWorkerToken(input: {
    name: string;
    tokenHash: string;
    scopes?: WorkerTokenRecord["scopes"];
  }): Promise<WorkerTokenRecord> {
    const rows = await this.db
      .insert(workerTokens)
      .values({
        orgId: this.orgId,
        name: input.name,
        tokenHash: input.tokenHash,
        scopes: input.scopes ?? "jobs:write",
      })
      .returning();
    return toWorkerToken(rows[0]!);
  }

  async getWorkerTokenByHash(tokenHash: string): Promise<WorkerTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(workerTokens)
      .where(
        and(
          eq(workerTokens.orgId, this.orgId),
          eq(workerTokens.tokenHash, tokenHash),
          isNull(workerTokens.revokedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toWorkerToken(rows[0]) : null;
  }

  async listWorkerTokens(): Promise<WorkerTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(workerTokens)
      .where(eq(workerTokens.orgId, this.orgId))
      .orderBy(asc(workerTokens.createdAt));
    return rows.map(toWorkerToken);
  }

  async revokeWorkerToken(tokenId: string): Promise<boolean> {
    const rows = await this.db
      .update(workerTokens)
      .set({ revokedAt: sql`now()` as unknown as Date })
      .where(
        and(
          eq(workerTokens.id, tokenId),
          eq(workerTokens.orgId, this.orgId),
          isNull(workerTokens.revokedAt),
        ),
      )
      .returning({ id: workerTokens.id });
    return rows.length > 0;
  }
}

export class DrizzleOrgStore implements OrgStore {
  constructor(private readonly db: Db) {}

  async createOrg(input: { slug: string; name: string }): Promise<OrgRecord> {
    const rows = await this.db
      .insert(organizations)
      .values({ slug: input.slug, name: input.name })
      .returning();
    return rows[0]!;
  }

  async getOrgBySlug(slug: string): Promise<OrgRecord | null> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return rows[0] ?? null;
  }

  async addMember(input: {
    userId: string;
    orgId: string;
    role: MembershipRecord["role"];
  }): Promise<MembershipRecord> {
    // FK on organization_id rejects unknown orgs (memory.ts throws "org not found").
    const rows = await this.db
      .insert(memberships)
      .values({ userId: input.userId, organizationId: input.orgId, role: input.role })
      .returning();
    const row = rows[0]!;
    return { userId: row.userId, orgId: row.organizationId, role: row.role };
  }

  async membership(userId: string, orgId: string): Promise<MembershipRecord | null> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, orgId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { userId: row.userId, orgId: row.organizationId, role: row.role };
  }

  /**
   * Resolve a worker bearer token (hash) to its org. Revoked tokens never
   * match. `last_used_at` is touched at most once a minute so a polling
   * worker does not turn every claim into a write.
   */
  async findOrgByWorkerTokenHash(
    tokenHash: string,
  ): Promise<{ org: OrgRecord; token: WorkerTokenRecord } | null> {
    const rows = await this.db
      .select({ token: workerTokens, org: organizations })
      .from(workerTokens)
      .innerJoin(organizations, eq(organizations.id, workerTokens.orgId))
      .where(and(eq(workerTokens.tokenHash, tokenHash), isNull(workerTokens.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await this.db
      .update(workerTokens)
      .set({ lastUsedAt: sql`now()` as unknown as Date })
      .where(
        and(
          eq(workerTokens.id, row.token.id),
          or(isNull(workerTokens.lastUsedAt), sql`${workerTokens.lastUsedAt} < now() - interval '60 seconds'`),
        ),
      );
    return { org: row.org, token: toWorkerToken(row.token) };
  }

  scoped(orgId: string): ScopedRepos {
    // Existence is checked lazily: every query is org-pinned, so an unknown
    // org id yields empty reads / FK-rejected writes instead of a race.
    return new ScopedPg(orgId, this.db);
  }
}

