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
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./pg";
import {
  annotations,
  auditLog,
  datasets,
  evalRuns,
  images,
  memberships,
  organizations,
  traces,
} from "./schema";
import type {
  AnnotationRecord,
  AuditRecord,
  DatasetRecord,
  EvalRunRecord,
  ImageRecord,
  MembershipRecord,
  OrgRecord,
  OrgStore,
  ScopedRepos,
  TraceRecord,
} from "./repos";

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

  scoped(orgId: string): ScopedRepos {
    // Existence is checked lazily: every query is org-pinned, so an unknown
    // org id yields empty reads / FK-rejected writes instead of a race.
    return new ScopedPg(orgId, this.db);
  }
}

