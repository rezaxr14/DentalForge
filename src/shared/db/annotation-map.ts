/**
 * Mapping between the editor's `Annotation` (contract) and a stored annotation row, shared by both stores so they
 * cannot disagree on how a box is flattened, ordered or canonicalised (ADR-0019).
 */
import type { Annotation } from "../contracts/labels";
import { toFloat4 } from "./ingest-rules";
import { isSetTransition } from "../domain/editing/persist";
import type { AnnotationRecord, AuditRecord, SetDecision } from "./repos";

/** The columns an op batch can change on a box row (everything except identity, org and set). */
export type RowFields = Pick<
  AnnotationRecord,
  | "bboxX" | "bboxY" | "bboxW" | "bboxH"
  | "fdiQuadrant" | "fdiPosition" | "pathology" | "source"
  | "confidence" | "status" | "version" | "authorId" | "modelId" | "position"
>;

/** Boxes and confidence are `real` (float32) columns; the memory store canonicalises the same way so reads agree. */
export function canonicalAnnotation(a: Annotation): Annotation {
  return {
    ...a,
    bbox: [toFloat4(a.bbox[0]), toFloat4(a.bbox[1]), toFloat4(a.bbox[2]), toFloat4(a.bbox[3])],
    confidence: a.confidence === null ? null : toFloat4(a.confidence),
  };
}

export function toRowFields(a: Annotation, position: number): RowFields {
  return {
    bboxX: a.bbox[0],
    bboxY: a.bbox[1],
    bboxW: a.bbox[2],
    bboxH: a.bbox[3],
    fdiQuadrant: a.fdi_quadrant,
    fdiPosition: a.fdi_position,
    pathology: a.pathology,
    source: a.source,
    confidence: a.confidence,
    status: a.status,
    version: a.version,
    authorId: a.author_id,
    modelId: a.model_id ?? null,
    position,
  };
}

type RowLike = RowFields & Pick<AnnotationRecord, "clientId">;

export function toAnnotation(r: RowLike): Annotation {
  return {
    id: r.clientId,
    bbox: [r.bboxX, r.bboxY, r.bboxW, r.bboxH],
    fdi_quadrant: r.fdiQuadrant,
    fdi_position: r.fdiPosition,
    pathology: r.pathology,
    source: r.source,
    confidence: r.confidence,
    status: r.status,
    version: r.version,
    // Legacy rows written before authorship was recorded have none; the contract requires one.
    author_id: r.authorId ?? "unknown",
    // Only model boxes carry one; the key is absent otherwise so human boxes keep their exact wire shape.
    ...(r.modelId ? { model_id: r.modelId } : {}),
  };
}

export function sameRowFields(a: RowFields, b: RowFields): boolean {
  return (
    a.bboxX === b.bboxX && a.bboxY === b.bboxY && a.bboxW === b.bboxW && a.bboxH === b.bboxH &&
    a.fdiQuadrant === b.fdiQuadrant && a.fdiPosition === b.fdiPosition && a.pathology === b.pathology &&
    a.source === b.source && a.confidence === b.confidence && a.status === b.status &&
    a.version === b.version && a.authorId === b.authorId && a.position === b.position
  );
}

/** Editor order. Ties (legacy rows all at position 0) fall back to the client id so both stores list identically. */
export function byEditorOrder(a: { position: number; clientId: string }, b: { position: number; clientId: string }): number {
  return a.position - b.position || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0);
}

const DECISION_PREFIX = "annotation_set.";

/**
 * An audit row as a decision, or null when it is not one: another action, or a row whose meta lacks the set's new version
 * (`transitionAnnotationSet` always writes it, so such a row did not come from there). Shared by both stores, which read the
 * rows differently but must agree on what counts as a decision.
 */
export function decisionOf(a: AuditRecord): SetDecision | null {
  if (!a.action.startsWith(DECISION_PREFIX)) return null;
  const transition = a.action.slice(DECISION_PREFIX.length);
  if (!isSetTransition(transition)) return null;
  const { version, reason } = a.meta as { version?: unknown; reason?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  return { transition, actorId: a.actorId, at: a.createdAt, version, reason: typeof reason === "string" ? reason : null };
}

/** The history of one set: its decisions, oldest first (by the version each one produced; the clock only breaks ties). */
export function decisionsOf(rows: AuditRecord[]): SetDecision[] {
  return rows
    .map(decisionOf)
    .filter((d): d is SetDecision => d !== null)
    .sort((a, b) => a.version - b.version || a.at.getTime() - b.at.getTime());
}
