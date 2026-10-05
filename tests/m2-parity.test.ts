import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDentalDiagnosis, computeFindingCloseness } from "../src/shared/domain/metrics";
import { matchMultiFindings } from "../src/shared/domain/matching";
import { expectedCalibrationError } from "../src/shared/domain/calibration";
import { bootstrapMetricCi, bootstrapPairedDiffCi } from "../src/shared/domain/bootstrap";

const goldens = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "goldens", "m2_goldens.json"), "utf-8"),
) as {
  normalize_diagnosis: Record<string, string>;
  closeness: { pred: Record<string, unknown>; out: [number, number, number] }[];
  match_multi: {
    fdi_f1: number; exact_f1: number; closeness_score: number;
    spatial_proximity: number; diagnostic_similarity: number;
    fdi_tp: number; exact_tp: number; matched_pairs: unknown[];
  };
  ece: { perfect: number; overconfident: number; empty: number };
  bootstrap_ci: [number, number, number];
  bootstrap_paired: { mean: number; lo: number; hi: number };
};

const LOOSE = 0.06;

describe("M2 parity: normalize_dental_diagnosis", () => {
  const cases = goldens.normalize_diagnosis;
  for (const [input, expected] of Object.entries(cases)) {
    it(`normalizes ${JSON.stringify(input)} -> ${expected}`, () => {
      const raw = input === "None" ? null : input === "" ? "" : input;
      expect(normalizeDentalDiagnosis(raw)).toBe(expected);
    });
  }
});

describe("M2 parity: compute_finding_closeness", () => {
  const cases = goldens.closeness;
  const gt = { quadrant: 4, tooth_position: 8, diagnosis: "Impacted" };
  it.each(cases.map((c, i) => [i, c] as const))("pair %i matches golden", (_i, c) => {
    const [comp, s, d] = computeFindingCloseness(gt, c.pred);
    expect(comp).toBeCloseTo(c.out[0] as number, 9);
    expect(s).toBeCloseTo(c.out[1] as number, 9);
    expect(d).toBeCloseTo(c.out[2] as number, 9);
  });
});

describe("M2 parity: match_multi_findings", () => {
  it("matches golden exactly (F1, closeness, pair flags)", () => {
    const g = goldens.match_multi;
    const gts = [
      { quadrant: 4, tooth_position: 8, diagnosis: "Impacted" },
      { quadrant: 4, tooth_position: 7, diagnosis: "Caries" },
      { quadrant: 3, tooth_position: 8, diagnosis: "Impacted" },
    ];
    const preds = [
      { quadrant: 4, tooth_position: 8, diagnosis: "Impacted Tooth", confidence: 0.95 },
      { quadrant: 4, tooth_position: 7, diagnosis: "Deep Caries", confidence: 0.85 },
      { quadrant: 1, tooth_position: 1, diagnosis: "Caries", confidence: 0.5 },
    ];
    const r = matchMultiFindings(gts, preds);
    expect(r.fdi_f1).toBeCloseTo(g.fdi_f1, 9);
    expect(r.exact_f1).toBeCloseTo(g.exact_f1, 9);
    expect(r.closeness_score).toBeCloseTo(g.closeness_score, 9);
    expect(r.spatial_proximity).toBeCloseTo(g.spatial_proximity, 9);
    expect(r.diagnostic_similarity).toBeCloseTo(g.diagnostic_similarity, 9);
    expect(r.fdi_tp).toBe(g.fdi_tp);
    expect(r.exact_tp).toBe(g.exact_tp);
    expect(r.matched_pairs).toHaveLength(g.matched_pairs.length);
  });
});

describe("M2 parity: ECE", () => {
  it("matches golden exactly", () => {
    const g = goldens.ece;
    expect(expectedCalibrationError([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0])).toBeCloseTo(g.perfect, 6);
    expect(expectedCalibrationError([0.9, 0.9, 0.9, 0.9], [1, 0, 0, 0])).toBeCloseTo(g.overconfident, 6);
    expect(expectedCalibrationError([], [])).toBe(g.empty);
  });
});

describe("M2 parity: bootstrap CIs (statistical, PRNG differs from numpy)", () => {
  it("point estimates exact, CIs close", () => {
    const g = goldens.bootstrap_ci;
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const [pt, lo, hi] = bootstrapMetricCi([0.2, 0.4, 0.6, 0.8, 1.0], mean);
    expect(pt).toBeCloseTo(g[0], 12);
    expect(lo).toBeCloseTo(g[1], LOOSE);
    expect(hi).toBeCloseTo(g[2], LOOSE);
    expect(lo).toBeLessThanOrEqual(pt);
    expect(hi).toBeGreaterThanOrEqual(pt);
  });
  it("paired diff mean exact, CI close", () => {
    const g = goldens.bootstrap_paired;
    const [mean, [lo, hi]] = bootstrapPairedDiffCi([0.5, 0.6, 0.7], [0.4, 0.5, 0.6]);
    expect(mean).toBeCloseTo(g.mean, 12);
    expect(lo).toBeCloseTo(g.lo, LOOSE);
    expect(hi).toBeCloseTo(g.hi, LOOSE);
  });
});
