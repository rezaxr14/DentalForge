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
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./pg";
import {
  annotationSets,
  annotations,
  artifacts,
  auditLog,
  datasets,
  evalCases,
  evalRuns,
  images,
  invites,
  jobEvents,
  jobs,
  memberships,
  modelRegistry,
  organizations,
  rewardSamples,
  toolCalls,
  traceTurns,
  traces,
  trainingMetrics,
  trainingRuns,
  workerTokens,
  workers,
} from "./schema";
import {
  DEFAULT_QUEUE_TTL_MS,
  gateJobWrite,
  type AnnotationRecord,
  type AnnotationSetRecord,
  type AnnotationSetSnapshot,
  type ApplyOpsOutcome,
  type ArtifactRecord,
  type AuditRecord,
  type DatasetRecord,
  type EvalRunRecord,
  type ImageRecord,
  type ImageSourceKey,
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
  type NewAnnotation,
  type OpenImageInput,
  type OrgRecord,
  type OrgStore,
  type RegisterModelInput,
  type RewardSampleRecord,
  type ScopedRepos,
  type TraceRecord,
  type TraceTurnRecord,
  type TrainingMetricRecord,
  type TrainingRunRecord,
  type TransitionOutcome,
  type WorkerRecord,
  type WorkerTokenRecord,
} from "./repos";
import { mergeRunStatus } from "./ingest-rules";
import { canonicalAnnotation, sameRowFields, toAnnotation, toRowFields } from "./annotation-map";
import { applyOpsToSet, canTransition, transitionTarget, type SetTransition } from "@/shared/domain/editing/persist";
import type { Command } from "@/shared/domain/editing/history";
import type { Role } from "@/shared/domain/auth";
import { summarizeEval } from "@/shared/lib/import/parse";

/** Rows per INSERT: 1000 × 4 params stays far below Postgres' 65 535-parameter limit. */
const INGEST_CHUNK = 1000;

function chunks<T>(rows: T[], size = INGEST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

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

  async createAnnotation(input: NewAnnotation): Promise<AnnotationRecord> {
    const img = await this.db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.id, input.imageId), eq(images.orgId, this.orgId)))
      .limit(1);
    if (!img.length) throw new Error("image not found in org");
    const id = randomUUID();
    const rows = await this.db
      .insert(annotations)
      .values({ ...input, id, clientId: id, orgId: this.orgId })
      .returning();
    return rows[0]!;
  }

  // ------------------------------------------------------------ annotation sets (ADR-0019)

  private async imageByKey(tx: Tx, key: ImageSourceKey): Promise<ImageRecord | null> {
    const rows = await tx
      .select({ image: images })
      .from(images)
      .innerJoin(datasets, eq(images.datasetId, datasets.id))
      .where(
        and(
          eq(images.orgId, this.orgId),
          eq(datasets.orgId, this.orgId),
          eq(datasets.source, key.source),
          eq(images.sourceImageId, key.sourceImageId),
        ),
      )
      // The oldest dataset of the source wins (an import's dataset over a lazily registered one), same as MemoryStore.
      .orderBy(asc(datasets.createdAt), asc(datasets.id))
      .limit(1);
    const r = rows[0]?.image;
    // Explicit mapping: the row also carries `createdAt`, which is not part of ImageRecord and must not leak into snapshots.
    return r
      ? { id: r.id, orgId: r.orgId, datasetId: r.datasetId, sourceImageId: r.sourceImageId, contentHash: r.contentHash, width: r.width, height: r.height, storageKey: r.storageKey, split: r.split }
      : null;
  }

  private async setRowFor(tx: Tx, imageId: string, lock: boolean): Promise<AnnotationSetRecord | null> {
    const q = tx
      .select()
      .from(annotationSets)
      .where(and(eq(annotationSets.imageId, imageId), eq(annotationSets.orgId, this.orgId)))
      .limit(1);
    const rows = await (lock ? q.for("update") : q);
    const r = rows[0];
    return r
      ? { id: r.id, orgId: r.orgId, imageId: r.imageId, assigneeId: r.assigneeId, state: r.state, version: r.version, submittedAt: r.submittedAt }
      : null;
  }

  private boxRows(tx: Tx, setId: string) {
    return tx
      .select()
      .from(annotations)
      .where(and(eq(annotations.setId, setId), eq(annotations.orgId, this.orgId)))
      // COLLATE "C" = the code-unit order MemoryStore uses for ties, so both stores list identically.
      .orderBy(asc(annotations.position), sql`${annotations.clientId} COLLATE "C"`);
  }

  private async snapshotOf(tx: Tx, set: AnnotationSetRecord, image: ImageRecord): Promise<AnnotationSetSnapshot> {
    const rows = await this.boxRows(tx, set.id);
    return { set, image, annotations: rows.map(toAnnotation) };
  }

  async openAnnotationSet(input: OpenImageInput & { assigneeId: string }): Promise<AnnotationSetSnapshot> {
    return this.db.transaction(async (tx) => {
      // Two first-time opens of the same org must not register two datasets (datasets have no unique key).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`annotation-open:${this.orgId}`}))`);
      let image = await this.imageByKey(tx, input);
      if (!image) {
        let ds = (
          await tx
            .select()
            .from(datasets)
            .where(and(eq(datasets.orgId, this.orgId), eq(datasets.source, input.source)))
            .orderBy(asc(datasets.createdAt), asc(datasets.id))
            .limit(1)
        )[0];
        if (!ds) {
          ds = (
            await tx
              .insert(datasets)
              .values({ orgId: this.orgId, name: input.datasetName, source: input.source, licenseNote: input.licenseNote ?? null })
              .returning()
          )[0]!;
        }
        const inserted = await tx
          .insert(images)
          .values({
            orgId: this.orgId,
            datasetId: ds.id,
            sourceImageId: input.sourceImageId,
            contentHash: input.contentHash,
            width: input.width,
            height: input.height,
            storageKey: input.storageKey,
            split: input.split,
          })
          .returning();
        const row = inserted[0]!;
        image = { id: row.id, orgId: row.orgId, datasetId: row.datasetId, sourceImageId: row.sourceImageId, contentHash: row.contentHash, width: row.width, height: row.height, storageKey: row.storageKey, split: row.split };
      }
      let set = await this.setRowFor(tx, image.id, false);
      if (!set) {
        await tx.insert(annotationSets).values({ orgId: this.orgId, imageId: image.id, assigneeId: input.assigneeId });
        set = (await this.setRowFor(tx, image.id, false))!;
      }
      return this.snapshotOf(tx, set, image);
    });
  }

  async getAnnotationSet(key: ImageSourceKey): Promise<AnnotationSetSnapshot | null> {
    return this.db.transaction(async (tx) => {
      const image = await this.imageByKey(tx, key);
      const set = image ? await this.setRowFor(tx, image.id, false) : null;
      return image && set ? this.snapshotOf(tx, set, image) : null;
    });
  }

  async applyAnnotationOps(
    input: ImageSourceKey & { baseVersion: number; ops: Command[]; actorId: string },
  ): Promise<ApplyOpsOutcome> {
    return this.db.transaction(async (tx) => {
      const image = await this.imageByKey(tx, input);
      // FOR UPDATE: concurrent batches on one set queue here, so the version check below cannot be raced.
      const set = image ? await this.setRowFor(tx, image.id, true) : null;
      if (!image || !set) return { kind: "not_found" } as const;
      const existing = await this.boxRows(tx, set.id);
      const current: AnnotationSetSnapshot = { set, image, annotations: existing.map(toAnnotation) };
      if (set.version !== input.baseVersion) return { kind: "conflict", reason: "version", snapshot: current } as const;
      if (set.state !== "draft") return { kind: "conflict", reason: "state", snapshot: current } as const;

      const res = applyOpsToSet(current.annotations, input.ops, {
        width: image.width,
        height: image.height,
        actorId: input.actorId,
        normalize: canonicalAnnotation,
      });
      if (!res.ok) return { kind: "invalid", message: res.message } as const;
      if (!res.changed) return { kind: "ok", snapshot: current } as const;

      const byClient = new Map(existing.map((r) => [r.clientId, r]));
      const keep = new Set(res.annotations.map((a) => a.id));
      const removed = existing.filter((r) => !keep.has(r.clientId)).map((r) => r.id);
      if (removed.length) await tx.delete(annotations).where(and(eq(annotations.orgId, this.orgId), inArray(annotations.id, removed)));

      const inserts: (typeof annotations.$inferInsert)[] = [];
      const moved: { clientId: string; position: number }[] = [];
      for (const [position, a] of res.annotations.entries()) {
        const fields = toRowFields(a, position);
        const row = byClient.get(a.id);
        if (!row) {
          inserts.push({ ...fields, orgId: this.orgId, imageId: image.id, setId: set.id, clientId: a.id, createdBy: input.actorId });
        } else if (!sameRowFields(row, fields)) {
          if (sameRowFields({ ...fields, position: row.position }, row)) moved.push({ clientId: a.id, position });
          else await tx.update(annotations).set({ ...fields, updatedAt: new Date() }).where(and(eq(annotations.id, row.id), eq(annotations.orgId, this.orgId)));
        }
      }
      if (inserts.length) await tx.insert(annotations).values(inserts);
      if (moved.length) {
        // Position-only changes (everything after an insert/delete shifts) in ONE statement instead of one per row.
        const values = sql.join(moved.map((m) => sql`(${m.clientId}, ${m.position}::int)`), sql`, `);
        await tx.execute(
          sql`update annotations a set position = v.pos from (values ${values}) as v(cid, pos)
              where a.set_id = ${set.id} and a.org_id = ${this.orgId} and a.client_id = v.cid`,
        );
      }
      await tx.update(annotationSets).set({ version: sql`${annotationSets.version} + 1` }).where(eq(annotationSets.id, set.id));
      // Re-read instead of building the result in JS: what the caller sees is what was written.
      return { kind: "ok", snapshot: await this.snapshotOf(tx, (await this.setRowFor(tx, image.id, false))!, image) } as const;
    });
  }

  async transitionAnnotationSet(
    input: ImageSourceKey & {
      baseVersion: number;
      transition: SetTransition;
      actorId: string;
      role: Role;
      reason?: string;
    },
  ): Promise<TransitionOutcome> {
    return this.db.transaction(async (tx) => {
      const image = await this.imageByKey(tx, input);
      const set = image ? await this.setRowFor(tx, image.id, true) : null;
      if (!image || !set) return { kind: "not_found" } as const;
      const current = await this.snapshotOf(tx, set, image);
      if (!canTransition(input.role, input.transition, input.actorId, set.assigneeId, current.annotations)) {
        return { kind: "forbidden" } as const;
      }
      if (set.version !== input.baseVersion) return { kind: "conflict", reason: "version", snapshot: current } as const;
      const target = transitionTarget(set.state, input.transition);
      if (!target) return { kind: "conflict", reason: "state", snapshot: current } as const;

      const now = new Date();
      await tx.update(annotations).set({ status: target, updatedAt: now }).where(and(eq(annotations.setId, set.id), eq(annotations.orgId, this.orgId)));
      await tx
        .update(annotationSets)
        .set({
          state: target,
          version: sql`${annotationSets.version} + 1`,
          ...(input.transition === "submit" ? { submittedAt: now } : input.transition === "reopen" ? { submittedAt: null } : {}),
        })
        .where(eq(annotationSets.id, set.id));
      await tx.insert(auditLog).values({
        orgId: this.orgId,
        actorId: input.actorId,
        action: `annotation_set.${input.transition}`,
        resource: set.id,
        meta: { imageId: image.id, sourceImageId: image.sourceImageId, version: set.version + 1, reason: input.reason ?? null },
      });
      return { kind: "ok", snapshot: await this.snapshotOf(tx, (await this.setRowFor(tx, image.id, false))!, image) } as const;
    });
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

  async registerModel(input: RegisterModelInput): Promise<{ model: ModelRecord; created: boolean }> {
    // Omitted optional fields are left out of `set`, so a re-register keeps the stored value.
    const set: Partial<typeof modelRegistry.$inferInsert> = { kind: input.kind };
    if (input.hfPath !== undefined) set.hfPath = input.hfPath;
    if (input.onnxArtifactId !== undefined) set.onnxArtifactId = input.onnxArtifactId;
    if (input.meta !== undefined) set.meta = input.meta;
    const rows = await this.db
      .insert(modelRegistry)
      .values({
        orgId: this.orgId,
        name: input.name,
        kind: input.kind,
        stage: input.stage,
        hfPath: input.hfPath ?? null,
        onnxArtifactId: input.onnxArtifactId ?? null,
        meta: input.meta ?? {},
      })
      .onConflictDoUpdate({ target: [modelRegistry.orgId, modelRegistry.name, modelRegistry.stage], set })
      // xmax = 0 only for a freshly inserted row (the standard "was this an insert?" upsert probe).
      .returning({ ...getTableColumns(modelRegistry), inserted: sql<boolean>`(xmax = 0)` });
    const { inserted, ...model } = rows[0]!;
    return { model, created: inserted };
  }

  async listModels(): Promise<ModelRecord[]> {
    return this.db
      .select()
      .from(modelRegistry)
      .where(eq(modelRegistry.orgId, this.orgId))
      .orderBy(asc(modelRegistry.createdAt), sql`${modelRegistry.name} COLLATE "C"`);
  }

  async ingestTraining(input: IngestTrainingInput): Promise<IngestTrainingResult> {
    return this.db.transaction(async (tx) => {
      // 1. The run, identified by (org, kind, name). DO NOTHING + locked re-read keeps the
      //    status merge race-free when two sessions create/update the same run at once.
      const fresh = await tx
        .insert(trainingRuns)
        .values({
          orgId: this.orgId,
          kind: input.run.kind,
          name: input.run.name,
          config: input.run.config ?? {},
          status: input.run.status ?? "running",
        })
        .onConflictDoNothing()
        .returning();
      let run: TrainingRunRecord;
      let runCreated: boolean;
      if (fresh[0]) {
        run = fresh[0];
        runCreated = true;
      } else {
        const existing = (
          await tx
            .select()
            .from(trainingRuns)
            .where(
              and(
                eq(trainingRuns.orgId, this.orgId),
                eq(trainingRuns.kind, input.run.kind),
                eq(trainingRuns.name, input.run.name),
              ),
            )
            .for("update")
        )[0]!;
        const updated = await tx
          .update(trainingRuns)
          .set({
            status: mergeRunStatus(existing.status, input.run.status),
            ...(input.run.config !== undefined ? { config: input.run.config } : {}),
          })
          .where(eq(trainingRuns.id, existing.id))
          .returning();
        run = updated[0]!;
        runCreated = false;
      }

      // 2. Metrics: upsert on the table's own primary key (run, step, name).
      let metricsInserted = 0;
      for (const part of chunks(input.metrics)) {
        const rows = await tx
          .insert(trainingMetrics)
          .values(part.map((m) => ({ runId: run.id, step: m.step, name: m.name, value: m.value })))
          .onConflictDoUpdate({
            target: [trainingMetrics.runId, trainingMetrics.step, trainingMetrics.name],
            set: { value: sql`excluded.value`, ts: sql`now()` },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        metricsInserted += rows.filter((r) => r.inserted).length;
      }

      // 3. Reward samples: upsert on (run, step, trajectory_ref).
      let rewardSamplesInserted = 0;
      for (const part of chunks(input.rewardSamples)) {
        const rows = await tx
          .insert(rewardSamples)
          .values(
            part.map((r) => ({
              orgId: this.orgId,
              runId: run.id,
              step: r.step,
              trajectoryRef: r.trajectoryRef,
              components: r.components,
              total: r.total,
            })),
          )
          .onConflictDoUpdate({
            target: [rewardSamples.runId, rewardSamples.step, rewardSamples.trajectoryRef],
            set: { components: sql`excluded.components`, total: sql`excluded.total` },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        rewardSamplesInserted += rows.filter((r) => r.inserted).length;
      }
      return { run, runCreated, metricsInserted, rewardSamplesInserted };
    });
  }

  async listTrainingRuns(): Promise<TrainingRunRecord[]> {
    return this.db
      .select()
      .from(trainingRuns)
      .where(eq(trainingRuns.orgId, this.orgId))
      .orderBy(asc(trainingRuns.createdAt), sql`${trainingRuns.name} COLLATE "C"`);
  }

  async listTrainingMetrics(runId: string): Promise<TrainingMetricRecord[]> {
    // training_metrics has no org column: ownership is proven by joining the run.
    const rows = await this.db
      .select({ runId: trainingMetrics.runId, step: trainingMetrics.step, name: trainingMetrics.name, value: trainingMetrics.value })
      .from(trainingMetrics)
      .innerJoin(trainingRuns, eq(trainingRuns.id, trainingMetrics.runId))
      .where(and(eq(trainingMetrics.runId, runId), eq(trainingRuns.orgId, this.orgId)))
      .orderBy(asc(trainingMetrics.step), sql`${trainingMetrics.name} COLLATE "C"`);
    return rows;
  }

  async listRewardSamples(runId: string): Promise<RewardSampleRecord[]> {
    return this.db
      .select()
      .from(rewardSamples)
      .where(and(eq(rewardSamples.runId, runId), eq(rewardSamples.orgId, this.orgId)))
      .orderBy(asc(rewardSamples.step), sql`${rewardSamples.trajectoryRef} COLLATE "C"`);
  }

  async ingestTrace(input: IngestTraceInput): Promise<IngestTraceResult> {
    return this.db.transaction(async (tx) => {
      // Resolve dataset and image INSIDE this org: FKs alone would let a caller attach a trace to another tenant's image.
      const ds = await tx
        .select({ id: datasets.id })
        .from(datasets)
        .where(and(eq(datasets.id, input.datasetId), eq(datasets.orgId, this.orgId)))
        .limit(1);
      if (!ds[0]) return { outcome: "rejected", reason: "unknown_dataset" } as const;
      const img = await tx
        .select({ id: images.id })
        .from(images)
        .where(
          and(
            eq(images.orgId, this.orgId),
            eq(images.datasetId, input.datasetId),
            eq(images.sourceImageId, input.sourceImageId),
          ),
        )
        .limit(1);
      if (!img[0]) return { outcome: "rejected", reason: "unknown_image" } as const;
      const imageId = img[0].id;

      const fresh = await tx
        .insert(traces)
        .values({
          orgId: this.orgId,
          datasetId: input.datasetId,
          imageId,
          cohort: input.cohort,
          mode: input.mode,
          verified: input.verified,
          sourceFile: input.sourceFile,
          contentHash: input.contentHash,
          nTurns: input.nTurns,
          nToolCalls: input.nToolCalls,
          formatOk: input.formatOk,
          verifierReason: input.verifierReason,
          groundTruth: input.groundTruth,
          finalAnswer: input.finalAnswer,
        })
        .onConflictDoNothing()
        .returning();
      if (!fresh[0]) {
        // Identity already present (possibly inserted by a concurrent request that has now committed): first import wins.
        const existing = (
          await tx
            .select()
            .from(traces)
            .where(
              and(
                eq(traces.orgId, this.orgId),
                eq(traces.datasetId, input.datasetId),
                eq(traces.imageId, imageId),
                eq(traces.cohort, input.cohort),
                eq(traces.mode, input.mode),
              ),
            )
            .limit(1)
        )[0]!;
        return { outcome: "existing", trace: existing, sameContent: existing.contentHash === input.contentHash } as const;
      }
      const trace = fresh[0];

      if (input.turns.length > 0) {
        const turnRows = await tx
          .insert(traceTurns)
          .values(
            input.turns.map((t) => ({
              orgId: this.orgId,
              traceId: trace.id,
              idx: t.idx,
              status: t.status,
              thought: t.thought,
              rawOutput: t.rawOutput,
              parsed: t.parsed as Record<string, unknown> | null,
            })),
          )
          .returning({ id: traceTurns.id, idx: traceTurns.idx });
        const turnId = new Map(turnRows.map((r) => [r.idx, r.id]));
        const calls = input.turns.flatMap((t) =>
          t.toolCalls.map((c) => ({
            orgId: this.orgId,
            turnId: turnId.get(t.idx)!,
            idx: c.idx,
            toolName: c.toolName,
            args: c.args,
            ok: c.ok,
            error: c.error,
            trueBbox: c.trueBbox,
            perturbTier: c.perturbTier,
          })),
        );
        for (const part of chunks(calls, 500)) {
          await tx.insert(toolCalls).values(part);
        }
      }
      return { outcome: "inserted", trace, sameContent: true } as const;
    });
  }

  async listTraceTurns(traceId: string): Promise<TraceTurnRecord[]> {
    const owned = await this.db
      .select({ id: traces.id })
      .from(traces)
      .where(and(eq(traces.id, traceId), eq(traces.orgId, this.orgId)))
      .limit(1);
    if (!owned[0]) return [];
    const turns = await this.db
      .select()
      .from(traceTurns)
      .where(and(eq(traceTurns.traceId, traceId), eq(traceTurns.orgId, this.orgId)))
      .orderBy(asc(traceTurns.idx));
    if (turns.length === 0) return [];
    const calls = await this.db
      .select()
      .from(toolCalls)
      .where(and(inArray(toolCalls.turnId, turns.map((t) => t.id)), eq(toolCalls.orgId, this.orgId)))
      .orderBy(asc(toolCalls.idx));
    return turns.map((t) => ({
      id: t.id,
      traceId: t.traceId,
      idx: t.idx,
      status: t.status ?? "",
      thought: t.thought,
      rawOutput: t.rawOutput,
      parsed: t.parsed,
      toolCalls: calls
        .filter((c) => c.turnId === t.id)
        .map((c) => ({
          id: c.id,
          idx: c.idx,
          toolName: c.toolName,
          args: c.args as Record<string, unknown>,
          ok: c.ok,
          error: c.error,
          trueBbox: c.trueBbox,
          perturbTier: c.perturbTier,
        })),
    }));
  }

  async ingestEvalCases(input: IngestEvalInput): Promise<IngestEvalResult> {
    return this.db.transaction(async (tx) => {
      // 1. The run, identified by (org, runKey). DO NOTHING + locked re-read keeps concurrent chunks of one
      //    run serialized, so the recomputed summary below always sees every committed case.
      const fresh = await tx
        .insert(evalRuns)
        .values({
          orgId: this.orgId,
          runKey: input.runKey,
          dataset: input.run.dataset,
          split: input.run.split,
          provider: input.run.provider,
          model: input.run.model,
          canonicalResize: input.run.canonicalResize,
          n: 0,
          sourceFile: `api:${input.runKey}`,
          summary: {},
        })
        .onConflictDoNothing()
        .returning();
      let run = fresh[0];
      const runCreated = run !== undefined;
      if (!run) {
        run = (
          await tx
            .select()
            .from(evalRuns)
            .where(and(eq(evalRuns.orgId, this.orgId), eq(evalRuns.runKey, input.runKey)))
            .for("update")
        )[0]!;
        const m = input.run;
        if (run.dataset !== m.dataset || run.split !== m.split || run.provider !== m.provider || run.model !== m.model || run.canonicalResize !== m.canonicalResize) {
          return { outcome: "run_mismatch", run } as const;
        }
      }
      const runId = run.id;

      // 2. Cases: upsert on (run, source image).
      let casesInserted = 0;
      for (const part of chunks(input.cases, 100)) {
        const rows = await tx
          .insert(evalCases)
          .values(
            part.map((c) => ({
              orgId: this.orgId,
              runId,
              imageId: null,
              sourceImageId: c.sourceImageId,
              groundTruth: c.groundTruth,
              predictionsJson: c.predictions,
              matchedPairs: c.matchedPairs,
              fdiF1: c.fdiF1,
              exactF1: c.exactF1,
              closeness: c.closeness,
              spatial: c.spatial,
              diagSim: c.diagSim,
              confidence: c.confidence,
              formatOk: c.formatOk,
              rawOutput: c.rawOutput,
            })),
          )
          .onConflictDoUpdate({
            target: [evalCases.runId, evalCases.sourceImageId],
            set: {
              groundTruth: sql`excluded.ground_truth`,
              predictionsJson: sql`excluded.predictions`,
              matchedPairs: sql`excluded.matched_pairs`,
              fdiF1: sql`excluded.fdi_f1`,
              exactF1: sql`excluded.exact_f1`,
              closeness: sql`excluded.closeness`,
              spatial: sql`excluded.spatial`,
              diagSim: sql`excluded.diag_sim`,
              confidence: sql`excluded.confidence`,
              formatOk: sql`excluded.format_ok`,
              rawOutput: sql`excluded.raw_output`,
            },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        casesInserted += rows.filter((r) => r.inserted).length;
      }

      // 3. n and summary are COMPUTED from every stored case (never accumulated), in a fixed order.
      const stored = await tx
        .select({
          fdiF1: evalCases.fdiF1,
          exactF1: evalCases.exactF1,
          closeness: evalCases.closeness,
          spatial: evalCases.spatial,
          diagSim: evalCases.diagSim,
          formatOk: evalCases.formatOk,
        })
        .from(evalCases)
        .where(eq(evalCases.runId, runId))
        .orderBy(asc(evalCases.sourceImageId));
      const updated = await tx
        .update(evalRuns)
        .set({
          n: stored.length,
          summary: summarizeEval(
            stored.map((c) => ({
              fdiF1: c.fdiF1 ?? 0,
              exactF1: c.exactF1 ?? 0,
              closeness: c.closeness ?? 0,
              spatial: c.spatial ?? 0,
              diagSim: c.diagSim ?? 0,
              formatOk: c.formatOk ?? false,
            })),
          ),
        })
        .where(eq(evalRuns.id, runId))
        .returning();
      return { outcome: "ok", run: updated[0]!, runCreated, casesInserted } as const;
    });
  }

  async listEvalCases(runId: string): Promise<EvalCaseRecord[]> {
    const rows = await this.db
      .select()
      .from(evalCases)
      .where(and(eq(evalCases.runId, runId), eq(evalCases.orgId, this.orgId)))
      .orderBy(asc(evalCases.sourceImageId));
    return rows.map((c) => ({
      id: c.id,
      runId: c.runId,
      sourceImageId: c.sourceImageId,
      groundTruth: c.groundTruth,
      predictions: c.predictionsJson,
      matchedPairs: c.matchedPairs,
      fdiF1: c.fdiF1,
      exactF1: c.exactF1,
      closeness: c.closeness,
      spatial: c.spatial,
      diagSim: c.diagSim,
      confidence: c.confidence,
      formatOk: c.formatOk,
      rawOutput: c.rawOutput,
    }));
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

