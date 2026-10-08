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
}

/** Top-level store: orgs, memberships, and the `scoped()` entry point. */
export interface OrgStore {
  createOrg(input: { slug: string; name: string }): Promise<OrgRecord>;
  getOrgBySlug(slug: string): Promise<OrgRecord | null>;
  addMember(input: { userId: string; orgId: string; role: MembershipRecord["role"] }): Promise<MembershipRecord>;
  membership(userId: string, orgId: string): Promise<MembershipRecord | null>;
  scoped(orgId: string): ScopedRepos;
}
