import { z } from "zod";

/**
 * M5 LabelForge contracts — plan §7 (Annotations / annotation_sets /
 * review_decisions / agreement_stats / queue_scores / dataset_exports).
 *
 * Bbox format: [x, y, w, h] in NATIVE image pixels (plan §4.3). Fixtures
 * store bboxes in the pixel space of the shipped image variant; generators
 * record the original dataset pixel space for provenance.
 */

export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** DENTEX diagnosis classes (generator mapping) + Tufts classes are accepted as raw strings. */
export const PATHOLOGY_LABELS = [
  "Caries",
  "Deep Caries",
  "Periapical Lesion",
  "Impacted",
] as const;

export const AnnotationSource = z.enum(["gt_import", "model", "human"]);
export type AnnotationSource = z.infer<typeof AnnotationSource>;

export const AnnotationStatus = z.enum(["draft", "submitted", "approved", "rejected"]);
export type AnnotationStatus = z.infer<typeof AnnotationStatus>;

export const Annotation = z.object({
  id: z.string().min(1),
  bbox: BBox,
  fdi_quadrant: z.number().int().min(1).max(4),
  fdi_position: z.number().int().min(1).max(8),
  pathology: z.string().min(1),
  source: AnnotationSource,
  confidence: z.number().min(0).max(1).nullable().default(null),
  status: AnnotationStatus.default("draft"),
  version: z.number().int().min(1).default(1),
  author_id: z.string().min(1),
});
export type Annotation = z.infer<typeof Annotation>;

/** annotation_sets row (plan §7): version = optimistic-concurrency token. */
export const AnnotationSet = z.object({
  image_id: z.string().min(1),
  assignee_id: z.string().min(1),
  state: AnnotationStatus,
  version: z.number().int().min(1),
  submitted_at: z.string().nullable(),
  annotations: z.array(Annotation),
});
export type AnnotationSet = z.infer<typeof AnnotationSet>;

export const ReviewDecision = z.object({
  annotation_set_id: z.string().min(1),
  reviewer_id: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().default(""),
  decided_at: z.string(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * agreement_stats (plan §7). kappa is null when there are no units to score
 * (both sets empty) — the UI shows "n/a", never a fabricated number.
 */
export const AgreementStats = z.object({
  image_id: z.string().min(1),
  annotator_a: z.string().min(1),
  annotator_b: z.string().min(1),
  iou_threshold: z.number().min(0).max(1),
  matched: z.number().int().min(0),
  units: z.number().int().min(0),
  kappa: z.number().nullable(),
  pct_agree: z.number().min(0).max(1),
});
export type AgreementStats = z.infer<typeof AgreementStats>;

/** queue_scores (plan §7); computed_by is heuristic until a worker tier exists. */
export const QueueScore = z.object({
  image_id: z.string().min(1),
  strategy: z.string().min(1),
  score: z.number(),
  computed_by: z.enum(["worker", "heuristic"]),
});
export type QueueScore = z.infer<typeof QueueScore>;

/** One prediction box from a stored YOLO run (plan §7 predictions rows / replay tier). */
export const PredictionBox = z.object({
  bbox: BBox,
  fdi_quadrant: z.number().int().min(1).max(4),
  fdi_position: z.number().int().min(1).max(8),
  confidence: z.number().min(0).max(1),
  class_idx: z.number().int().min(0).max(31),
});
export type PredictionBox = z.infer<typeof PredictionBox>;

/**
 * One labelable image = shipped image variant + real GT (DENTEX consensus)
 * + optional real stored model predictions (replay tier pre-labels).
 */
export const LabelFixture = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  dataset: z.enum(["dentex"]),
  image_path: z.string().min(1),
  /** Pixel space of gt/prediction bboxes = original dataset dims (plan §4.3). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Shipped web variant dims (downscaled JPEG); editor scales by variant/width. */
  variant_width: z.number().int().positive(),
  variant_height: z.number().int().positive(),
  source_file: z.string().min(1),
  license: z.string().min(1),
  /** DENTEX consensus boxes, source gt_import, always status approved. */
  gt: z.array(Annotation),
  /** Stored YOLO CV predictions (replay tier); null when no run is committed. */
  predictions: z.array(PredictionBox).nullable(),
  prediction_model: z.string().nullable(),
});
export type LabelFixture = z.infer<typeof LabelFixture>;
