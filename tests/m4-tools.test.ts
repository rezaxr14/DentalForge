import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Rgb, contralateralComposite, denoiseBilateral, denoiseMedian,
  enhanceContrast, luma8, windowLevel,
} from "../src/shared/domain/toolImage";
import {
  boxOutOfBounds, nudgeCrop, zoomCropRect,
} from "../src/shared/domain/toolGeometry";
import { anatomicalName, fdiFromParts, fdiLabel, fdiToParts, flipQuadrant } from "../src/shared/domain/fdi";

const g = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "goldens", "m4_tools.json"), "utf-8"),
) as {
  contrast_gray: { in: number[]; factor: number; out: number[] };
  contrast_rgb: { in: number[][]; factor: number; out: number[][] };
  contrast_tie: { in: number[]; factor: number; out: number[] };
  window_presets: Record<string, { center: number; width: number }>;
  window_out: Record<string, number[]>;
  zoom_crop: { basic: number[]; clamped: number[]; min_pad_50: number[]; oob_true: boolean; oob_false: boolean };
  nudge: {
    shift: { bbox: number[]; note: string };
    scale_up: { bbox: number[]; note: string };
    bad: { error: string };
  };
  fdi: { encode_48: number; decode_48: number[]; label_36: string; label_bad: string | null; anatomy_11: string; flip_1: number; flip_3: number };
  denoise_in: number[][];
  denoise_median_0_6: number[][];
  denoise_bilateral_0_6: number[][];
  contralateral: { size: number[]; target_pixel: number[]; mirror_pixel: number[]; divider_pixel: number[]; oob_fallback_size: number[] };
};

/** gray ints -> RGB triples (PIL L->RGB on enhance input) */
const grayRgb = (vals: number[]): Rgb =>
  Uint8Array.from(vals.flatMap((v) => [v, v, v]));
const triples = (rows: number[][]): Rgb => Uint8Array.from(rows.flat());
const at = (d: Rgb, i: number): number[] => [d[3 * i]!, d[3 * i + 1]!, d[3 * i + 2]!];

describe("M4: luma bit-exact vs PIL.convert('L')", () => {
  it("round-to-nearest Rec.601", () => {
    expect(luma8(100, 150, 200)).toBe(141); // float 140.75 -> 141 (PIL rounds)
    expect(luma8(200, 100, 50)).toBe(124);  // float 124.2 -> 124
    expect(luma8(0, 0, 0)).toBe(0);
    expect(luma8(255, 255, 255)).toBe(255);
  });
});

describe("M4: enhanceContrast parity (exact)", () => {
  it("gray degenerate blend, factor 1.5", () => {
    const out = enhanceContrast(grayRgb(g.contrast_gray.in), g.contrast_gray.factor);
    for (let i = 0; i < 4; i++) expect(at(out, i)).toEqual([g.contrast_gray.out[i] as number, g.contrast_gray.out[i] as number, g.contrast_gray.out[i] as number]);
  });
  it("color input: L-convert mean then per-channel blend", () => {
    const out = enhanceContrast(triples(g.contrast_rgb.in), g.contrast_rgb.factor);
    expect(g.contrast_rgb.in.map((_, i) => at(out, i))).toEqual(g.contrast_rgb.out);
  });
  it("ties truncate toward zero (PIL Image.blend)", () => {
    const out = enhanceContrast(grayRgb(g.contrast_tie.in), g.contrast_tie.factor);
    for (let i = 0; i < 4; i++) expect(at(out, i)[0]).toBe(g.contrast_tie.out[i]);
  });
});

describe("M4: windowLevel parity (exact)", () => {
  const src = triples([[0, 0, 0], [100, 100, 100], [150, 150, 150], [255, 255, 255]]);
  const lvals = (d: Rgb): number[] => [d[0]!, d[3]!, d[6]!, d[9]!];
  it("presets match WINDOW_PRESETS golden", () => {
    expect(g.window_presets.bone).toEqual({ center: 128, width: 100 });
    expect(g.window_presets.enamel).toEqual({ center: 200, width: 100 });
    expect(g.window_presets.soft_tissue).toEqual({ center: 80, width: 150 });
    expect(g.window_presets.metal_reduction).toEqual({ center: 100, width: 200 });
  });
  it("all four presets", () => {
    for (const preset of ["bone", "enamel", "soft_tissue", "metal_reduction"]) {
      expect(lvals(windowLevel(src, preset)), preset).toEqual(g.window_out[preset]);
    }
  });
  it("center/width override + bad preset falls back to bone", () => {
    expect(lvals(windowLevel(src, "bone", 100, 50))).toEqual(g.window_out.custom_c100_w50);
    expect(lvals(windowLevel(src, "nope"))).toEqual(g.window_out.bad_preset_falls_back_to_bone);
  });
});


describe("M4: zoom_crop / nudge / oob geometry parity (exact)", () => {
  it("zoom crop rects (100x80 image)", () => {
    const basic = zoomCropRect(100, 80, [10, 10, 20, 20]);
    expect([basic.width, basic.height]).toEqual(g.zoom_crop.basic);
    const clamped = zoomCropRect(100, 80, [90, 70, 30, 30]);
    expect([clamped.width, clamped.height]).toEqual(g.zoom_crop.clamped);
    const minPad = zoomCropRect(100, 80, [40, 40, 4, 4]);
    expect([minPad.width, minPad.height]).toEqual(g.zoom_crop.min_pad_50);
  });
  it("box_out_of_bounds", () => {
    expect(boxOutOfBounds([90, 70, 30, 30], 100, 80)).toBe(g.zoom_crop.oob_true);
    expect(boxOutOfBounds([10, 10, 20, 20], 100, 80)).toBe(g.zoom_crop.oob_false);
  });
  it("nudge shift/scale/error", () => {
    const shift = nudgeCrop(1000, 800, [100, 100, 200, 100], 0.5, -0.5, 1.0);
    expect(shift.bbox).toEqual(g.nudge.shift.bbox);
    expect(shift.note).toBe(g.nudge.shift.note);
    const up = nudgeCrop(1000, 800, [100, 100, 200, 100], 0, 0, 2.0);
    expect(up.bbox).toEqual(g.nudge.scale_up.bbox);
    expect(nudgeCrop(1000, 800, [1, 2, 3]).error).toBe(g.nudge.bad.error);
  });
});

describe("M4: denoise parity", () => {
  const src = triples(g.denoise_in);
  it("median is exact vs cv2 golden", () => {
    const out = denoiseMedian(src, 8, 8, 0.6);
    const got = Array.from({ length: 64 }, (_, i) => at(out, i));
    expect(got).toEqual(g.denoise_median_0_6);
  });
  it("bilateral matches cv2 bit-exact (L1²/circle/reflect101 formula, ADR-0004)", () => {
    const out = denoiseBilateral(src, 8, 8, 0.6);
    const got = Array.from({ length: 64 }, (_, i) => at(out, i));
    expect(got).toEqual(g.denoise_bilateral_0_6);
  });
});

describe("M4: contralateral composite parity (exact geometry)", () => {
  // source: 40x20 gray(10,10,10), red px at (5,5), green px at (31,5)
  const w = 40, h = 20;
  const src = new Uint8Array(w * h * 3).fill(10);
  const put = (x: number, y: number, rgb: number[]): void => {
    const i = 3 * (y * w + x);
    src[i] = rgb[0]!; src[i + 1] = rgb[1]!; src[i + 2] = rgb[2]!;
  };
  put(5, 5, [200, 30, 30]);
  put(31, 5, [30, 200, 30]);

  const comp = contralateralComposite(src, w, h, [4, 4, 6, 6], 1);
  const pix = (d: Rgb, cw: number, x: number, y: number): number[] => {
    const i = 3 * (y * cw + x);
    return [d[i]!, d[i + 1]!, d[i + 2]!];
  };
  it("size, target/mirror/divider pixels", () => {
    expect([comp.w, comp.h]).toEqual(g.contralateral.size);
    expect(pix(comp.data, comp.w, 1, 1)).toEqual(g.contralateral.target_pixel);
    expect(pix(comp.data, comp.w, 17, 1)).toEqual(g.contralateral.mirror_pixel);
    expect(pix(comp.data, comp.w, 6, 1)).toEqual(g.contralateral.divider_pixel);
  });
  it("out-of-bounds bbox falls back to full image copy", () => {
    const full = contralateralComposite(src, w, h, [100, 100, 5, 5], 1);
    expect([full.w, full.h]).toEqual(g.contralateral.oob_fallback_size);
  });
  it("rejects invalid args like Python", () => {
    expect(() => contralateralComposite(src, w, h, [1, 2, 3], 1)).toThrow();
    expect(() => contralateralComposite(src, w, h, [1, 2, 3, 4], 5)).toThrow();
  });
});

describe("M4: FDI tool helpers parity", () => {
  it("encode/decode/label/anatomy/flip match Python golden", () => {
    expect(fdiFromParts(4, 8)).toBe(g.fdi.encode_48);
    const p = fdiToParts(g.fdi.decode_48[0]! * 10 + g.fdi.decode_48[1]!);
    expect([p.quadrant, p.position]).toEqual(g.fdi.decode_48);
    expect(fdiLabel(3, 6)).toBe(g.fdi.label_36);
    expect(fdiLabel(5, 9)).toBe(g.fdi.label_bad);
    expect(anatomicalName(11)).toBe(g.fdi.anatomy_11);
    expect(flipQuadrant(1)).toBe(g.fdi.flip_1);
    expect(flipQuadrant(3)).toBe(g.fdi.flip_3);
    expect(() => flipQuadrant(9)).toThrow();
  });
});
