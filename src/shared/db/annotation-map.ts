/**
 * Mapping between the editor's `Annotation` (contract) and a stored annotation row, shared by both stores so they
 * cannot disagree on how a box is flattened, ordered or canonicalised (ADR-0019).
 */
import type { Annotation } from "../contracts/labels";
import { toFloat4 } from "./ingest-rules";
import type { AnnotationRecord } from "./repos";

/** The columns an op batch can change on a box row (everything except identity, org and set). */
export type RowFields = Pick<
  AnnotationRecord,
  | "bboxX" | "bboxY" | "bboxW" | "bboxH"
  | "fdiQuadrant" | "fdiPosition" | "pathology" | "source"
  | "confidence" | "status" | "version" | "authorId" | "position"
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
