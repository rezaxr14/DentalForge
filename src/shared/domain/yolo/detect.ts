/**
 * Browser YOLO geometry and decoding - pure, dependency-free (ADR-0027).
 *
 * The numbers here were fitted to the exported graph, not guessed: the model is
 * `yolov8m-dentex-fp16-640.onnx`, input `images` [1,3,640,640] float32 in 0..1
 * RGB, output `output0` [1,36,8400] float32 where rows 0-3 are `cx,cy,w,h` in
 * letterboxed pixels and rows 4-35 are the 32 tooth-class scores (sigmoid
 * already applied by the graph).
 *
 * `scripts/export_yolo_golden.py` produces `fixtures/yolo/*.json` from the
 * Python reference implementation; `tests/m11-browser-yolo.test.ts` asserts this
 * module reproduces those boxes, so a change here that drifts from the export is
 * a failing test rather than a silently worse pre-label.
 */

/** Letterbox geometry: how the original image sits inside the 640x640 input. */
export interface LetterboxMeta {
  /** Original image width in pixels. */
  width: number;
  /** Original image height in pixels. */
  height: number;
  /** Square input side the model was exported with. */
  size: number;
  /** Uniform scale applied to the original image. */
  scale: number;
  /** Padding on the left in input pixels. */
  left: number;
  /** Padding on the top in input pixels. */
  top: number;
  /** Scaled image width in input pixels. */
  scaledWidth: number;
  /** Scaled image height in input pixels. */
  scaledHeight: number;
}

/** A detection in ORIGINAL image pixels (not the letterboxed input). */
export interface Detection {
  /** [x, y, w, h] in original image pixels, clipped to the image. */
  bbox: [number, number, number, number];
  confidence: number;
  /** 0-31, `Tooth 11` .. `Tooth 48`. */
  classIdx: number;
  fdiQuadrant: number;
  fdiPosition: number;
}

/**
 * Ultralytics' letterbox, rounded exactly like the Python reference:
 * `round` on a half goes away from zero in Python 3 but towards +Infinity in
 * JS, and the `-0.1` nudge keeps the two sides from disagreeing by a pixel.
 */
export function letterbox(
  width: number,
  height: number,
  size = 640,
  pad = 114,
): LetterboxMeta & { pad: number } {
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError(`invalid image size: ${width}x${height}`);
  }
  const scale = Math.min(size / width, size / height);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  // `Math.max(0, ...)` also turns JS's `-0` into `+0`, so a golden fixture
  // written by Python (`round(-0.1) == 0`) compares equal with `toBe`.
  const left = Math.max(0, Math.round((size - scaledWidth) / 2 - 0.1));
  const top = Math.max(0, Math.round((size - scaledHeight) / 2 - 0.1));
  return { width, height, size, scale, left, top, scaledWidth, scaledHeight, pad };
}

/** IoU of two [x1,y1,x2,y2] boxes. */
export function iou(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union =
    (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy NMS over [x1,y1,x2,y2] boxes, highest score first. Class-agnostic on
 * purpose: two teeth never overlap enough for this to matter, and Ultralytics'
 * class-aware NMS produced the same boxes on every golden image.
 */
export function nms(
  boxes: ReadonlyArray<readonly [number, number, number, number]>,
  scores: ReadonlyArray<number>,
  iouThreshold: number,
): number[] {
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
  const keep: number[] = [];
  const suppressed = new Set<number>();
  for (const index of order) {
    if (suppressed.has(index)) continue;
    keep.push(index);
    for (const other of order) {
      if (other === index || suppressed.has(other)) continue;
      if (iou(boxes[index]!, boxes[other]!) > iouThreshold) suppressed.add(other);
    }
  }
  return keep;
}

export interface DecodeOptions {
  /** Minimum class score, ADR-0027 default 0.25. */
  confidenceThreshold?: number;
  /** NMS IoU, ADR-0027 default 0.45. */
  iouThreshold?: number;
}

/**
 * Decode `output0` into detections in original pixels.
 *
 * `output` is the flat [36 x anchors] tensor, row-major, as ORT returns it.
 */
export function decodeDetections(
  output: Float32Array,
  meta: LetterboxMeta,
  options: DecodeOptions = {},
): Detection[] {
  const confidenceThreshold = options.confidenceThreshold ?? 0.25;
  const iouThreshold = options.iouThreshold ?? 0.45;
  const rows = 36;
  const anchors = output.length / rows;
  if (!Number.isInteger(anchors)) {
    throw new RangeError(`unexpected output length ${output.length}`);
  }

  const candidateBoxes: Array<[number, number, number, number]> = [];
  const candidateScores: number[] = [];
  const candidateClasses: number[] = [];

  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestClass = -1;
    let bestScore = -Infinity;
    for (let cls = 0; cls < 32; cls += 1) {
      const score = output[(4 + cls) * anchors + anchor]!;
      if (score > bestScore) {
        bestScore = score;
        bestClass = cls;
      }
    }
    if (!(bestScore >= confidenceThreshold)) continue;
    const cx = output[anchor]!;
    const cy = output[anchors + anchor]!;
    const w = output[2 * anchors + anchor]!;
    const h = output[3 * anchors + anchor]!;
    candidateBoxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
    candidateScores.push(bestScore);
    candidateClasses.push(bestClass);
  }

  const kept = nms(candidateBoxes, candidateScores, iouThreshold);
  const detections: Detection[] = [];
  for (const index of kept) {
    const [x1, y1, x2, y2] = candidateBoxes[index]!;
    const left = clamp((x1 - meta.left) / meta.scale, 0, meta.width);
    const right = clamp((x2 - meta.left) / meta.scale, 0, meta.width);
    const top = clamp((y1 - meta.top) / meta.scale, 0, meta.height);
    const bottom = clamp((y2 - meta.top) / meta.scale, 0, meta.height);
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) continue;
    const classIdx = candidateClasses[index]!;
    detections.push({
      bbox: [left, top, w, h],
      confidence: candidateScores[index]!,
      classIdx,
      fdiQuadrant: Math.floor(classIdx / 8) + 1,
      fdiPosition: (classIdx % 8) + 1,
    });
  }
  detections.sort((a, b) => b.confidence - a.confidence);
  return detections;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Place already-scaled RGBA pixels into the 640x640 RGB tensor: 1:1 copy at
 * (left, top) over a 114/255 grey border - the same operation as PIL's
 * `resize(...).paste(..., (left, top))` in the Python reference. The caller does
 * the resampling with the browser's own filter, which is why this function takes
 * `scaledWidth x scaledHeight` pixels rather than the original image.
 */
export function letterboxPixels(
  source: Uint8ClampedArray,
  meta: LetterboxMeta,
): Float32Array {
  const { size, left, top, scaledWidth, scaledHeight } = meta;
  const border = ((meta as LetterboxMeta & { pad?: number }).pad ?? 114) / 255;
  const tensor = new Float32Array(3 * size * size);
  tensor.fill(border);
  const plane = size * size;
  for (let y = 0; y < scaledHeight; y += 1) {
    const rowBase = (top + y) * size + left;
    const srcRow = y * scaledWidth * 4;
    for (let x = 0; x < scaledWidth; x += 1) {
      const src = srcRow + x * 4;
      const dst = rowBase + x;
      tensor[dst] = source[src]! / 255;
      tensor[plane + dst] = source[src + 1]! / 255;
      tensor[2 * plane + dst] = source[src + 2]! / 255;
    }
  }
  return tensor;
}


