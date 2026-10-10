/**
 * M5 LabelForge domain — pure functions (plan §7 annotation workflow).
 *
 * Contains: bbox IoU + greedy matching, Cohen's kappa inter-annotator
 * agreement, review state machine + authorization seed, active-learning
 * heuristic, and YOLO/COCO export builders.
 */
import type { AgreementStats, Annotation, AnnotationStatus } from "../contracts/labels";
import { normalizeDentalDiagnosis } from "./metrics";
import { fdiToClassIdx, fdiToParts } from "./fdi";

export type Bbox = [number, number, number, number];

/** Intersection-over-union of two [x,y,w,h] boxes (native pixels). */
export function bboxIou(a: Bbox, b: Bbox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Clamp a drawn box into the image and enforce a minimum size. */
export function clampBox(box: Bbox, width: number, height: number, minSize = 4): Bbox | null {
  const x = Math.min(Math.max(0, box[0]), width);
  const y = Math.min(Math.max(0, box[1]), height);
  const x2 = Math.min(Math.max(0, box[0] + box[2]), width);
  const y2 = Math.min(Math.max(0, box[1] + box[3]), height);
  const w = x2 - x;
  const h = y2 - y;
  if (w < minSize || h < minSize) return null;
  return [x, y, w, h];
}

export interface PrelabelTarget {
  /** Fixture/annotation image id (used in the generated annotation ids). */
  imageId: string;
  /** Native image dimensions for clamping (plan §4.3). */
  width: number;
  height: number;
  /** Model id stamped into `author_id` (`yolo:<model>`). */
  modelId: string;
  /** Id suffix start — pass the current annotation count to avoid collisions. */
  startIdx: number;
}

/**
 * Stored YOLO predictions (replay tier, `fixtures/labels/*.json`) → draft
 * annotations. Suggestions are `source=model`, carry confidence, and are
 * clamped into the image (raw inference boxes may graze the edge).
 */
export function predictionsToAnnotations(
  preds: readonly { bbox: readonly number[]; fdi_quadrant: number; fdi_position: number; confidence: number }[],
  target: PrelabelTarget,
): Annotation[] {
  const out: Annotation[] = [];
  for (const p of preds) {
    const clamped = clampBox([p.bbox[0] ?? 0, p.bbox[1] ?? 0, p.bbox[2] ?? 0, p.bbox[3] ?? 0], target.width, target.height);
    if (!clamped) continue;
    out.push({
      id: `pred_${target.imageId}_${target.startIdx + out.length}`,
      bbox: clamped,
      fdi_quadrant: p.fdi_quadrant,
      fdi_position: p.fdi_position,
      pathology: "Caries",
      source: "model",
      confidence: p.confidence,
      status: "draft",
      version: 1,
      author_id: `yolo:${target.modelId}`,
    });
  }
  return out;
}

/**
 * `yolo.prelabel` worker result boxes → draft annotations (worker tier,
 * provenance `worker_exact`). Same shape rules as the replay tier so the two
 * paths are interchangeable.
 */
export function prelabelResultToAnnotations(
  boxes: readonly { bbox: readonly number[]; conf: number; fdiQuadrant: number; fdiPosition: number }[],
  target: PrelabelTarget,
): Annotation[] {
  return predictionsToAnnotations(
    boxes.map((b) => ({ bbox: b.bbox, fdi_quadrant: b.fdiQuadrant, fdi_position: b.fdiPosition, confidence: b.conf })),
    target,
  );
}

export interface MatchedPair<A, B> {
  a: A;
  b: B;
  iou: number;
}
/**
 * Greedy one-to-one matching by descending IoU (ties broken by indices for
 * determinism). Threshold is inclusive: iou >= threshold matches.
 */
export function matchBoxes<A, B>(
  as: A[],
  bs: B[],
  iou: (a: A, b: B) => number,
  threshold = 0.5,
): { pairs: MatchedPair<A, B>[]; unmatchedA: number[]; unmatchedB: number[] } {
  const candidates: { i: number; j: number; iou: number }[] = [];
  for (let i = 0; i < as.length; i++) {
    for (let j = 0; j < bs.length; j++) {
      const v = iou(as[i] as A, bs[j] as B);
      if (v >= threshold) candidates.push({ i, j, iou: v });
    }
  }
  candidates.sort((x, y) => y.iou - x.iou || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: MatchedPair<A, B>[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ a: as[c.i] as A, b: bs[c.j] as B, iou: c.iou });
  }
  const unmatchedA = as.map((_, i) => i).filter((i) => !usedA.has(i));
  const unmatchedB = bs.map((_, j) => j).filter((j) => !usedB.has(j));
  return { pairs, unmatchedA, unmatchedB };
}

/** Agreement key for one annotation: FDI number + normalized pathology. */
export function annotKey(a: { fdi_quadrant: number; fdi_position: number; pathology: string }): string {
  const parts = fdiToParts(a.fdi_quadrant * 10 + a.fdi_position);
  return `${parts.quadrant}${parts.position}:${normalizeDentalDiagnosis(a.pathology)}`;
}

/**
 * Cohen's kappa over paired categorical labels. Returns null when kappa is
 * undefined (no units, or expected agreement == 1) — plan forbids fabricating
 * the number; the UI renders null as "n/a".
 */
export function cohenKappa(labelsA: string[], labelsB: string[]): number | null {
  const n = labelsA.length;
  if (n === 0 || n !== labelsB.length) return null;
  const cats = new Set<string>();
  for (const l of labelsA) cats.add(l);
  for (const l of labelsB) cats.add(l);
  const list = [...cats];
  if (list.length <= 1) return null; // everyone agrees trivially — undefined kappa
  let agreed = 0;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const a = labelsA[i] as string;
    const b = labelsB[i] as string;
    if (a === b) agreed++;
    countA.set(a, (countA.get(a) ?? 0) + 1);
    countB.set(b, (countB.get(b) ?? 0) + 1);
  }
  const po = agreed / n;
  let pe = 0;
  for (const c of list) pe += ((countA.get(c) ?? 0) / n) * ((countB.get(c) ?? 0) / n);
  if (pe >= 1) return null;
  return (po - pe) / (1 - pe);
}

/**
 * Inter-annotator agreement between two annotation sets on one image.
 * Units = matched pairs + unmatched boxes (an unmatched box is its own unit
 * whose label on the other side is "<missing>", i.e. a disagreement), matching
 * plan §7 agreement_stats (matched, kappa, pct_agree).
 */
export function agreementStats(
  imageId: string,
  annotatorA: string,
  annotatorB: string,
  setA: Annotation[],
  setB: Annotation[],
  iouThreshold = 0.5,
): AgreementStats {
  const { pairs, unmatchedA, unmatchedB } = matchBoxes(
    setA,
    setB,
    (a, b) => bboxIou(a.bbox, b.bbox),
    iouThreshold,
  );
  const labelsA: string[] = [];
  const labelsB: string[] = [];
  let matched = 0;
  for (const p of pairs) {
    const ka = annotKey(p.a);
    const kb = annotKey(p.b);
    if (ka === kb) matched++;
    labelsA.push(ka);
    labelsB.push(kb);
  }
  for (const i of unmatchedA) {
    labelsA.push(annotKey(setA[i] as Annotation));
    labelsB.push("<missing>");
  }
  for (const j of unmatchedB) {
    labelsA.push("<missing>");
    labelsB.push(annotKey(setB[j] as Annotation));
  }
  const units = labelsA.length;
  const agreed = labelsA.filter((l, i) => l === labelsB[i]).length;
  return {
    image_id: imageId,
    annotator_a: annotatorA,
    annotator_b: annotatorB,
    iou_threshold: iouThreshold,
    matched,
    units,
    kappa: cohenKappa(labelsA, labelsB),
    pct_agree: units === 0 ? 1 : agreed / units,
  };
}

// --- Review state machine (plan §7: draft→submitted→approved/rejected) ---

const TRANSITIONS: Record<AnnotationStatus, AnnotationStatus[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected", "draft"], // →draft = withdraw
  approved: [],
  rejected: ["draft"], // revise and resubmit
};

export function canTransition(from: AnnotationStatus, to: AnnotationStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function nextStates(from: AnnotationStatus): AnnotationStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/** Authorization seed for the future `can()` (plan §5.2). */
export type Role = "user" | "reviewer" | "admin";

export type Action = "annotate" | "submit" | "review" | "export";

export function can(role: Role, action: Action): boolean {
  switch (action) {
    case "annotate":
    case "submit":
    case "export":
      return true;
    case "review":
      return role === "reviewer" || role === "admin";
    default:
      return false;
  }
}

/** Self-review guard: reviewers must not approve their own sets. */
export function canReview(role: Role, isAuthor: boolean): boolean {
  return can(role, "review") && !isAuthor;
}

// --- Active-learning queue (plan §9: heuristic until a worker exists) ---

/**
 * Heuristic AL score in [0,1]: higher = more valuable to label next.
 * Mixes (1 - model confidence) uncertainty with GT sparsity. Labeled
 * `computed_by: "heuristic"` in the UI — never presented as model output.
 */
export function alQueueScore(opts: {
  meanConf: number | null;
  gtBoxes: number;
  labeledBoxes: number;
}): QueueScoreRow {
  const conf = opts.meanConf == null ? 0.5 : Math.min(1, Math.max(0, opts.meanConf));
  const uncertainty = 1 - conf;
  const gt = Math.max(1, opts.gtBoxes);
  const coverage = Math.min(1, opts.labeledBoxes / gt);
  const score = Math.round((0.7 * uncertainty + 0.3 * (1 - coverage)) * 1000) / 1000;
  return { score, strategy: "uncertainty+coverage", computed_by: "heuristic" };
}

export interface QueueScoreRow {
  score: number;
  strategy: string;
  computed_by: "worker" | "heuristic";
}

// --- YOLO / COCO export (plan §7 dataset_exports) ---

export interface ExportImage {
  id: string;
  file: string;
  width: number;
  height: number;
}

function isExportable(a: Annotation): boolean {
  return a.status === "approved" || a.status === "submitted";
}

/**
 * YOLO txt lines: `class cx cy w h`, normalized to [0,1], 6 decimals.
 * Class index = fdiToClassIdx (32 teeth, matches dataset.yaml).
 */
export function yoloLines(anns: Annotation[], width: number, height: number, onlyExportable = true): string[] {
  const rows: string[] = [];
  for (const a of anns) {
    if (onlyExportable && !isExportable(a)) continue;
    const [x, y, w, h] = a.bbox;
    const cls = fdiToClassIdx(a.fdi_quadrant, a.fdi_position);
    const cx = ((x + w / 2) / width).toFixed(6);
    const cy = ((y + h / 2) / height).toFixed(6);
    rows.push(`${cls} ${cx} ${cy} ${(w / width).toFixed(6)} ${(h / height).toFixed(6)}`);
  }
  return rows;
}

export interface CocoExport {
  info: { description: string; dentalforge: string };
  images: { id: string; file_name: string; width: number; height: number }[];
  annotations: {
    id: number;
    image_id: string;
    category_id: number;
    bbox: number[];
    area: number;
    iscrowd: number;
    fdi_quadrant: number;
    fdi_position: number;
    pathology: string;
    source: string;
  }[];
  categories: { id: number; name: string; supercategory: string }[];
}

/**
 * COCO export with 4 DENTEX pathology categories (matches the dataset's
 * quadrant-enumeration-disease categories). Image ids are kept as strings.
 */
export function cocoExport(
  images: ExportImage[],
  byImage: Record<string, Annotation[]>,
  onlyExportable = true,
): CocoExport {
  const categories = [
    { id: 1, name: "Impacted", supercategory: "pathology" },
    { id: 2, name: "Caries", supercategory: "pathology" },
    { id: 3, name: "Periapical Lesion", supercategory: "pathology" },
    { id: 4, name: "Deep Caries", supercategory: "pathology" },
  ];
  const catId = new Map(categories.map((c) => [c.name, c.id] as const));
  const annotations: CocoExport["annotations"] = [];
  let annId = 1;
  for (const img of images) {
    for (const a of byImage[img.id] ?? []) {
      if (onlyExportable && !isExportable(a)) continue;
      const name = pathologyToExportCategory(a.pathology, categories);
      annotations.push({
        id: annId++,
        image_id: img.id,
        category_id: catId.get(name) ?? 2,
        bbox: [...a.bbox],
        area: Math.round(a.bbox[2] * a.bbox[3]),
        iscrowd: 0,
        fdi_quadrant: a.fdi_quadrant,
        fdi_position: a.fdi_position,
        pathology: a.pathology,
        source: a.source,
      });
    }
  }
  return {
    info: { description: "DentalForge LabelForge export", dentalforge: "m5" },
    images: images.map((i) => ({ id: i.id, file_name: i.file, width: i.width, height: i.height })),
    annotations,
    categories,
  };
}

/** Map any diagnosis spelling onto the 4 export categories (via metrics normalizer). */
export function pathologyToExportCategory(pathology: string, categories: { name: string }[]): string {
  const n = normalizeDentalDiagnosis(pathology);
  const hit = categories.find((c) => c.name === n);
  if (hit) return hit.name;
  if (n === "Unknown") return "Caries";
  return categories[1]?.name ?? "Caries";
}


