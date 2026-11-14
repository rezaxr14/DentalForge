/**
 * Browser YOLO: letterbox, decode and NMS must reproduce the Python reference
 * (ADR-0027).
 *
 * `fixtures/yolo/*.json` were produced by `scripts/export_yolo_golden.py` from
 * the fp32 ONNX export over three held-out DENTEX validation images. They hold
 * only the candidate anchors (best class score >= 0.25) and the boxes the
 * reference decoder produced, so this suite runs in milliseconds without
 * onnxruntime and without the 50 MiB graph - while still failing the moment the
 * TypeScript decoder drifts from the export.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeDetections,
  iou,
  letterbox,
  letterboxPixels,
  nms,
  type LetterboxMeta,
} from "@/shared/domain/yolo/detect";
import { YOLO_MODEL, YOLO_MODEL_MB } from "@/shared/domain/yolo/model";
import { FEATURES } from "@/features/capability/features";
import { contextFor, emptySnapshot } from "@/features/capability/service";

interface Golden {
  image: string;
  meta: LetterboxMeta & { pad: number };
  confidenceThreshold: number;
  iouThreshold: number;
  anchors: number[][];
  expected: { bbox: [number, number, number, number]; confidence: number; classIdx: number }[];
}

const GOLDEN = ["val_18", "val_32", "val_44"].map(
  (name) =>
    JSON.parse(readFileSync(join(process.cwd(), "fixtures", "yolo", `${name}.json`), "utf8")) as Golden,
);

/** Rebuild the flat (36 x anchors) tensor the decoder consumes, column per anchor. */
function tensorFrom(anchors: number[][]): Float32Array {
  const rows = 36;
  const out = new Float32Array(rows * anchors.length);
  for (let anchor = 0; anchor < anchors.length; anchor += 1) {
    for (let row = 0; row < rows; row += 1) {
      out[row * anchors.length + anchor] = anchors[anchor]![row]!;
    }
  }
  return out;
}

describe("browser YOLO: letterbox geometry", () => {
  it("matches the Python reference for every golden image", () => {
    for (const golden of GOLDEN) {
      const meta = letterbox(golden.meta.width, golden.meta.height, YOLO_MODEL.size, YOLO_MODEL.pad);
      expect(meta.scale).toBeCloseTo(golden.meta.scale, 9);
      expect(meta.scaledWidth).toBe(golden.meta.scaledWidth);
      expect(meta.scaledHeight).toBe(golden.meta.scaledHeight);
      expect(meta.left).toBe(golden.meta.left);
      expect(meta.top).toBe(golden.meta.top);
    }
  });

  it("never upscales past the square and keeps the image centred", () => {
    const meta = letterbox(2744, 1316, 640, 114);
    expect(meta.scaledWidth).toBe(640);
    expect(meta.scaledHeight).toBe(307);
    expect(meta.left).toBe(0);
    expect(meta.top).toBe(166); // round((640 - 307) / 2 - 0.1)
    expect(meta.top * 2 + meta.scaledHeight).toBeLessThanOrEqual(640);
  });

  it("rejects a zero-sized image instead of producing NaN boxes", () => {
    expect(() => letterbox(0, 100)).toThrow(RangeError);
    expect(() => letterbox(100, -1)).toThrow(RangeError);
  });
});

describe("browser YOLO: decode parity with the Python reference", () => {
  for (const golden of GOLDEN) {
    it(`reproduces every box on ${golden.image}`, () => {
      const boxes = decodeDetections(tensorFrom(golden.anchors), golden.meta, {
        confidenceThreshold: golden.confidenceThreshold,
        iouThreshold: golden.iouThreshold,
      });
      expect(boxes).toHaveLength(golden.expected.length);
      for (let i = 0; i < boxes.length; i += 1) {
        const got = boxes[i]!;
        const want = golden.expected[i]!;
        const [x, y, w, h] = got.bbox;
        expect(iou([x, y, x + w, y + h], [want.bbox[0], want.bbox[1], want.bbox[0] + want.bbox[2], want.bbox[1] + want.bbox[3]]))
          .toBeGreaterThan(0.999);
        expect(got.confidence).toBeCloseTo(want.confidence, 5);
        expect(got.classIdx).toBe(want.classIdx);
        // FDI is derived, never stored: class 0 is tooth 11, class 31 is tooth 48.
        expect(got.fdiQuadrant).toBe(Math.floor(want.classIdx / 8) + 1);
        expect(got.fdiPosition).toBe((want.classIdx % 8) + 1);
      }
    });
  }

  it("drops every anchor below the confidence threshold", () => {
    const golden = GOLDEN[0]!;
    const tensor = tensorFrom(golden.anchors);
    const all = decodeDetections(tensor, golden.meta, { confidenceThreshold: 0, iouThreshold: 1 });
    const none = decodeDetections(tensor, golden.meta, { confidenceThreshold: 1.1, iouThreshold: 0.45 });
    expect(all.length).toBeGreaterThan(0);
    expect(none).toHaveLength(0);
  });

  it("clips boxes that reach past the image edge into the image", () => {
    const golden = GOLDEN[1]!;
    for (const box of decodeDetections(tensorFrom(golden.anchors), golden.meta, {})) {
      const [x, y, w, h] = box.bbox;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(golden.meta.width + 1e-6);
      expect(y + h).toBeLessThanOrEqual(golden.meta.height + 1e-6);
    }
  });

  it("returns boxes sorted by descending confidence", () => {
    const confidences = decodeDetections(tensorFrom(GOLDEN[2]!.anchors), GOLDEN[2]!.meta, {}).map(
      (b) => b.confidence,
    );
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });
});

describe("browser YOLO: NMS", () => {
  it("keeps the higher-scoring box of an overlapping pair", () => {
    const boxes: Array<[number, number, number, number]> = [
      [0, 0, 10, 10],
      [1, 1, 11, 11],
      [50, 50, 60, 60],
    ];
    expect(nms(boxes, [0.9, 0.8, 0.7], 0.45)).toEqual([0, 2]);
  });

  it("keeps both boxes when the overlap is below the threshold", () => {
    const boxes: Array<[number, number, number, number]> = [
      [0, 0, 10, 10],
      [9, 0, 19, 10],
    ];
    expect(nms(boxes, [0.9, 0.8], 0.45)).toEqual([0, 1]);
  });

  it("is deterministic for equal scores (stable by index)", () => {
    const boxes: Array<[number, number, number, number]> = [
      [0, 0, 10, 10],
      [0, 0, 10, 10],
    ];
    expect(nms(boxes, [0.5, 0.5], 0.45)).toEqual([0]);
  });
});

describe("browser YOLO: preprocessing", () => {
  it("pastes scaled pixels at (left, top) over the 114 grey border", () => {
    const meta = letterbox(4, 2, 4, 114); // scale 1, scaled 4x2, 1px border above and below
    const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(255);
    const tensor = letterboxPixels(pixels, meta);
    expect(tensor).toHaveLength(3 * 4 * 4);
    expect(meta.top).toBe(1);
    expect(tensor[0]).toBeCloseTo(114 / 255, 6); // row 0 is border
    expect(tensor[4]).toBeCloseTo(1, 6); // row 1, col 0 is the first image pixel
    expect(tensor[3 * 4]).toBeCloseTo(114 / 255, 6); // row 3 is border again
  });

  it("fills the border with 114/255 in all three channels", () => {
    const meta = letterbox(4, 2, 8, 114); // scale 2, scaled 8x4, 2px border above and below
    const pixels = new Uint8ClampedArray(8 * 4 * 4).fill(0);
    const tensor = letterboxPixels(pixels, meta);
    const plane = 8 * 8;
    expect(meta.top).toBe(2);
    expect(tensor[0]).toBeCloseTo(114 / 255, 6); // top-left is padding
    expect(tensor[plane]).toBeCloseTo(114 / 255, 6);
    expect(tensor[2 * plane]).toBeCloseTo(114 / 255, 6);
    expect(tensor[2 * 8]).toBeCloseTo(0, 6); // first image pixel, 2 rows down
  });
});

describe("browser YOLO: capability wiring", () => {
  it("advertises the browser rung only when the feature flag is on", () => {
    expect(FEATURES["yolo.prelabel"].browserReady).toBe(true);
    const snap = emptySnapshot("off", true, "integration-off");
    const ctx = contextFor("yolo.prelabel", snap, { hasReplay: true });
    expect(ctx.browserSupported).toBe(true);
    // A browser that cannot run it passes browserSupported: false and falls back to replay.
    const blocked = contextFor("yolo.prelabel", snap, { hasReplay: true, browserSupported: false });
    expect(blocked.browserSupported).toBe(false);
  });

  it("keeps the model size and digest in one place, and the label honest", () => {
    expect(YOLO_MODEL.bytes).toBe(51_878_944);
    expect(YOLO_MODEL_MB).toBe(49);
    expect(YOLO_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(YOLO_MODEL.url.startsWith("/models/yolo/")).toBe(true);
    expect(YOLO_MODEL.confidenceThreshold).toBe(0.25);
    expect(YOLO_MODEL.iouThreshold).toBe(0.45);
  });
});
