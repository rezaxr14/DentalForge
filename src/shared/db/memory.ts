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
}
