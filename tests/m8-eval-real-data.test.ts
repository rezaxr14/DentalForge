/**
 * ADR-0014 — real-data findings about the eval contract.
 *
 * The owner's real Qwen3.5-9B zero-shot file had 12 of 49 lines rejected by `EvalCase`: models put a whole FDI
 * code in `tooth_position` and emit `confidence: null`. The importer skipped those lines SILENTLY (n=37, every
 * mean biased) while `ingest/eval-run` 422'd the whole chunk. These tests pin: the shapes are now representable,
 * ground truth is still strict, skipped lines are always reported, and the diagnosis never leaks strings.
 * The reproductions are synthetic (derived from the sanitized fixture), not the private data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EvalCase, Finding, MatchedPair } from "@/shared/contracts/traces";
import { MAX_INVALID_SAMPLES, parseEvalFile, parseEvalFileDetailed } from "@/shared/lib/import/parse";
import { describeValue, diagnoseLines } from "@/shared/lib/import/diagnose";

const QWEN = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "evals", "qwen.json"), "utf8")) as Record<string, unknown> & {
  predictions: Record<string, unknown>[];
  ground_truth: Record<string, unknown>[];
};
const pred = (over: Record<string, unknown> = {}) => ({ quadrant: 3, tooth_position: 6, diagnosis: "Caries", ...over });
const mk = (imageId: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...QWEN, image_id: imageId, ...over });
const line = (o: unknown) => JSON.stringify(o);

/** The contract as it was BEFORE ADR-0014: model output validated like ground truth. */
const OldEvalCase = EvalCase.extend({ predictions: z.array(Finding), confidence: z.number().optional() });

describe("EvalCase now represents what real models emit", () => {
  it("accepts a whole FDI code in a prediction's tooth_position (18, 36, 48 …)", () => {
    for (const code of [18, 28, 36, 48]) {
      expect(EvalCase.safeParse(mk(1, { predictions: [pred({ tooth_position: code })] })).success, String(code)).toBe(true);
    }
  });

  it("accepts null confidence at the case level and on a predicted finding", () => {
    expect(EvalCase.safeParse(mk(1, { confidence: null })).success).toBe(true);
    expect(EvalCase.safeParse(mk(1, { predictions: [pred({ confidence: null })] })).success).toBe(true);
    expect(EvalCase.safeParse(mk(1, { predictions: [pred({ confidence: 0.4 })], confidence: 0.4 })).success).toBe(true);
  });

  it("accepts the same quirks in a matched pair's `pred`", () => {
    const pair = {
      gt: { quadrant: 3, tooth_position: 6, diagnosis: "Caries" },
      pred: pred({ tooth_position: 36, confidence: null }),
      fdi_match: false,
      exact_match: false,
      closeness: 0.2,
      spatial: 0.1,
      diag_sim: 1,
    };
    expect(MatchedPair.safeParse(pair).success).toBe(true);
  });

  it("the pre-ADR-0014 contract really did reject them (so this is a true reproduction)", () => {
    expect(OldEvalCase.safeParse(mk(1, { predictions: [pred({ tooth_position: 36 })] })).success).toBe(false);
    expect(OldEvalCase.safeParse(mk(1, { confidence: null })).success).toBe(false);
  });
});

describe("…but ground truth and real structure errors are still rejected", () => {
  const paths = (o: unknown) => {
    const r = EvalCase.safeParse(o);
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };
  it("ground truth keeps tooth_position 1–8 (it comes from the dataset)", () => {
    expect(paths(mk(1, { ground_truth: [pred({ tooth_position: 36 })] }))).toContain("ground_truth.0.tooth_position");
  });
  it("a matched pair's `gt` stays strict", () => {
    const pair = { gt: pred({ tooth_position: 36 }), pred: pred(), fdi_match: true, exact_match: true, closeness: 1, spatial: 1, diag_sim: 1 };
    expect(paths(mk(1, { matched_pairs: [pair] }))).toContain("matched_pairs.0.gt.tooth_position");
  });
  it("a prediction's tooth_position must still be an integer number", () => {
    expect(paths(mk(1, { predictions: [pred({ tooth_position: "36" })] }))).toContain("predictions.0.tooth_position");
    expect(paths(mk(1, { predictions: [pred({ tooth_position: 3.5 })] }))).toContain("predictions.0.tooth_position");
  });
  it("a prediction's confidence must still be a probability, and its quadrant 1–4", () => {
    expect(paths(mk(1, { predictions: [pred({ confidence: 2 })] }))).toContain("predictions.0.confidence");
    expect(paths(mk(1, { predictions: [pred({ quadrant: 9 })] }))).toContain("predictions.0.quadrant");
  });
  it("missing required fields are still invalid", () => {
    const { raw_output: _r, ...noRaw } = mk(1);
    void _r;
    expect(paths(noRaw)).toContain("raw_output");
  });
});

describe("parseEvalFileDetailed never skips silently", () => {
  const good = (n: number) => line(mk(n));
  const quirky = (n: number) => line(mk(n, { predictions: [pred({ tooth_position: 36 })], confidence: null }));

  it("imports the quirky lines (n counts them) and reports exactly what it could not use", () => {
    const { raw_output: _r, ...noRaw } = mk(4);
    void _r;
    const lines = [good(1), quirky(2), "", "   ", "{not json", line(noRaw), good(5)];
    const r = parseEvalFileDetailed("f.jsonl", lines);
    expect(r.nonBlankLines).toBe(5);
    expect(r.parsed!.run.n).toBe(3); // 1, 2 (quirky) and 5
    expect(r.invalidCount).toBe(2);
    expect(r.invalid.map((p) => p.line)).toEqual([5, 6]); // 1-based file lines, blanks counted
    expect(r.invalid[0]!.issues).toEqual(["not valid JSON"]);
    expect(r.invalid[1]!.issues[0]).toContain("raw_output");
    expect(parseEvalFile("f.jsonl", lines)).toEqual(r.parsed); // the old API returns the same data
  });

  it("a file with only invalid lines yields no run — but the loss is still visible", () => {
    const r = parseEvalFileDetailed("f.jsonl", ["{", "[]"]);
    expect(r.parsed).toBeNull();
    expect(r.invalidCount).toBe(2);
  });

  it(`keeps only the first ${MAX_INVALID_SAMPLES} samples but counts every invalid line`, () => {
    const r = parseEvalFileDetailed("f.jsonl", [good(1), ...Array.from({ length: 30 }, () => "{")]);
    expect(r.invalidCount).toBe(30);
    expect(r.invalid).toHaveLength(MAX_INVALID_SAMPLES);
  });

  it("the summary is over the lines that were used (and says so via n)", () => {
    const r = parseEvalFileDetailed("f.jsonl", [good(1), "{"]);
    expect(r.parsed!.run.n).toBe(1);
    expect(r.nonBlankLines - r.invalidCount).toBe(r.parsed!.run.n);
  });
});

describe("diagnoseLines", () => {
  const quirky = (n: number, over: Record<string, unknown> = {}) => line(mk(n, { predictions: [pred({ tooth_position: 36 })], ...over }));

  it("lists every failing path once, counted per LINE, with a value description (against the old contract)", () => {
    const lines = [
      quirky(1), // tooth_position 36
      quirky(2, { predictions: [pred({ tooth_position: 18 }), pred({ tooth_position: 48 })] }), // two issues, ONE line
      quirky(3, { confidence: null, predictions: [pred({ tooth_position: 36, confidence: null })] }),
      line(mk(4)), // valid under both
      "",
      "garbage",
    ];
    const d = diagnoseLines(OldEvalCase, lines);
    expect(d).toMatchObject({ total: 5, valid: 1, invalid: 4, notJson: 1 });
    const tooth = d.byPath.find((p) => p.path === "predictions.[].tooth_position")!;
    expect(tooth.lines).toBe(3); // lines 1, 2 and 3 — not 4 issues
    expect(tooth.example).toBe("number 36");
    expect(tooth.code).toBe("too_big");
    expect(d.byPath.find((p) => p.path === "confidence")!.example).toBe("null");
    expect(d.byPath[0]!.lines).toBeGreaterThanOrEqual(d.byPath[d.byPath.length - 1]!.lines); // sorted by impact
  });

  it("everything the CURRENT contract accepts diagnoses clean", () => {
    const d = diagnoseLines(EvalCase, [quirky(1), quirky(2, { confidence: null }), line(mk(3))]);
    expect(d).toMatchObject({ total: 3, valid: 3, invalid: 0, byPath: [] });
  });

  it("describes missing keys and never echoes strings from the data", () => {
    const { raw_output: _r, ...noRaw } = mk(1);
    void _r;
    const d = diagnoseLines(EvalCase, [line(noRaw), line(mk(2, { fdi_f1: "SECRET model output text" }))]);
    expect(d.byPath.find((p) => p.path === "raw_output")!.example).toBe("missing");
    expect(d.byPath.find((p) => p.path === "fdi_f1")!.example).toBe("string(24)");
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  it("describeValue covers every JSON type without printing content", () => {
    expect(describeValue({ found: true, value: null })).toBe("null");
    expect(describeValue({ found: true, value: 7 })).toBe("number 7");
    expect(describeValue({ found: true, value: true })).toBe("boolean true");
    expect(describeValue({ found: true, value: "abc" })).toBe("string(3)");
    expect(describeValue({ found: true, value: [1, 2] })).toBe("array(2)");
    expect(describeValue({ found: true, value: { a: 1 } })).toBe("object");
    expect(describeValue({ found: false })).toBe("missing");
  });
});
