/**
 * M10: versioned, tolerant readers (ADR-0024).
 *
 * These tests are the negative controls for the adapter layer: a line with unknown fields, a line
 * missing optional fields, and a line that cannot be read at all. Each must be counted and reported,
 * never thrown, and the reader version must be recorded on every row it produces.
 */
import { describe, expect, it } from "vitest";

import {
  EVAL_ADAPTER_VERSION,
  MAX_INVALID_SAMPLES,
  TRACE_ADAPTER_VERSION,
  parseEvalFileDetailed,
  readTraceLine,
  scanEvalLines,
  scanTraceLines,
  traceFileMeta,
} from "@/shared/vlm/adapters/trace";
import { newDiagnostics } from "@/shared/vlm/adapters/trace";

const META = traceFileMeta("train_cot_traces_dentex.jsonl");

function traceLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    image_id: 7,
    image_path: "C:/data/7.png",
    dataset: "dentex",
    ground_truth: [{ quadrant: 1, tooth_position: 1, diagnosis: "healthy", bbox: [1, 2, 3, 4] }],
    turns: [
      {
        turn: 1,
        status: "tool_call",
        tool_calls_this_turn: [{ tool_name: "zoom_crop", tool_args: { x: 1 }, tool_ok: true }],
      },
      {
        turn: 2,
        status: "final_answer",
        raw_output: "{}",
        parsed: { thought: "looks healthy", final_answer: [] },
      },
    ],
    tool_calls: 1,
    final_answer: [],
    messages: [],
    format_ok: true,
    ...overrides,
  });
}

function evalCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    image_id: 11,
    dataset: "dentex",
    split: "test",
    provider: "openai",
    model: "qwen3.5-4b",
    ground_truth: [{ quadrant: 1, tooth_position: 1, diagnosis: "healthy", bbox: [1, 2, 3, 4] }],
    predictions: [],
    matched_pairs: [],
    fdi_precision: 0.5,
    fdi_recall: 0.25,
    fdi_f1: 1 / 3,
    exact_precision: 0.2,
    exact_recall: 0.1,
    exact_f1: 0.15,
    closeness_score: 0.4,
    spatial_proximity: 0.6,
    diagnostic_similarity: 0.8,
    fdi_correct: true,
    quadrant_correct: true,
    tooth_position_correct: false,
    diagnosis_correct: true,
    exact_match: false,
    all_exact_match: false,
    raw_output: "{}",
    format_ok: true,
    finish_reason: "stop",
    confidence: null,
    ...overrides,
  };
}

describe("M10: trace adapter", () => {
  it("records the adapter version and defaults a missing optional field", () => {
    const { row, reason } = readTraceLine(traceLine(), "file.jsonl", META);
    expect(reason).toBeNull();
    expect(row!.adapterVersion).toBe(TRACE_ADAPTER_VERSION);
    expect(row!.verifierReason).toBeNull(); // verifier_reason is optional upstream
    expect(row!.extra).toEqual({});
    expect(row!.nTurns).toBe(2);
    expect(row!.nToolCalls).toBe(1);
    expect(row!.turns[1]!.thought).toBe("looks healthy");
  });

  it("keeps unknown fields instead of dropping them, and counts them by dotted path", () => {
    const d = newDiagnostics("trace", TRACE_ADAPTER_VERSION);
    const line = traceLine({
      new_upstream_key: { nested: 1 },
      turns: [
        {
          turn: 1,
          status: "tool_call",
          brand_new_turn_field: true,
          tool_calls_this_turn: [{ tool_name: "zoom_crop", tool_args: {}, tool_ok: true, brand_new_call_field: 2 }],
        },
      ],
      ground_truth: [
        { quadrant: 1, tooth_position: 1, diagnosis: "healthy", bbox: [1, 2, 3, 4], brand_new_gt_field: "x" },
      ],
    });

    const { row } = readTraceLine(line, "file.jsonl", META, d);

    // Tolerance: the row still imports, and nothing is silently lost.
    expect(row).not.toBeNull();
    expect(row!.extra).toEqual({ new_upstream_key: { nested: 1 } });
    expect(d.unknownFields).toMatchObject({
      new_upstream_key: 1,
      "turns[].brand_new_turn_field": 1,
      "turns[].tool_calls_this_turn[].brand_new_call_field": 1,
      "ground_truth[].brand_new_gt_field": 1,
    });
    expect(d.linesSkipped).toBe(0);
  });

  it("carries a live run's artifact id through the adapter (ADR-0025)", () => {
    const artifactId = "00000000-0000-4000-8000-0000000000c1";
    const line = traceLine({
      turns: [
        {
          turn: 0,
          status: "tool_call",
          tool_calls_this_turn: [
            { tool_name: "zoom_crop", tool_args: { bbox: [1, 2, 3, 4] }, tool_ok: true, artifact_id: artifactId },
          ],
        },
      ],
    });
    const { row } = readTraceLine(line, "agent.run:openai_compat:test", META);
    expect(row!.turns[0]!.toolCalls[0]!.artifactId).toBe(artifactId);
    // It is a known field, not an "unknown upstream field".
    expect(row!.extra).toEqual({});
  });

  it("counts and explains an unreadable line instead of throwing", () => {
    const lines = [traceLine(), "{not json", JSON.stringify({ image_id: "not-a-number" })];
    const d = scanTraceLines(lines, "file.jsonl", META);

    expect(d.linesRead).toBe(3);
    expect(d.linesSkipped).toBe(2);
    expect(d.skipped.map((s) => s.reason)).toEqual([
      "not valid JSON",
      expect.stringContaining("image_id"),
    ]);
  });

  it("skips blank lines without counting them as reads", () => {
    const d = scanTraceLines(["", "   ", traceLine()], "file.jsonl", META);
    expect(d.linesRead).toBe(1);
    expect(d.linesSkipped).toBe(0);
  });

  it("records shape variants it actually saw (dataset, tool_calls type)", () => {
    const d = scanTraceLines(
      [traceLine(), traceLine({ dataset: "tufts", tool_calls: [] })],
      "file.jsonl",
      META,
    );
    expect(d.variants).toMatchObject({
      "dataset=dentex": 1,
      "dataset=tufts": 1,
      "tool_calls=number": 1,
      "tool_calls=array": 1,
    });
  });
});

describe("M10: eval adapter", () => {
  it("records the adapter version and computes the summary from the cases", () => {
    const lines = [
      JSON.stringify(evalCase()),
      JSON.stringify(evalCase({ image_id: 12, fdi_f1: 1, exact_f1: 1, closeness_score: 1, spatial_proximity: 1, diagnostic_similarity: 1 })),
    ];
    const r = parseEvalFileDetailed("eval.jsonl", lines);

    expect(r.parsed!.run.adapterVersion).toBe(EVAL_ADAPTER_VERSION);
    expect(r.parsed!.run.n).toBe(2);
    expect(r.parsed!.run.summary.fdi_f1).toBeCloseTo((1 / 3 + 1) / 2);
    expect(r.parsed!.run.summary.format_ok_rate).toBe(1);
    expect(r.invalidCount).toBe(0);
    expect(r.diagnostics.variants["confidence=nullish"]).toBe(2);
  });

  it("counts every invalid line but keeps only the first MAX_INVALID_SAMPLES samples", () => {
    const lines = Array.from({ length: MAX_INVALID_SAMPLES + 5 }, (_, i) => `{"image_id": ${i}}`);
    const r = parseEvalFileDetailed("eval.jsonl", lines);

    expect(r.parsed).toBeNull();
    expect(r.invalidCount).toBe(MAX_INVALID_SAMPLES + 5);
    expect(r.invalid).toHaveLength(MAX_INVALID_SAMPLES);
    expect(r.diagnostics.linesSkipped).toBe(MAX_INVALID_SAMPLES + 5);
  });

  it("keeps and counts unknown eval fields without failing the case", () => {
    const d = scanEvalLines("eval.jsonl", [JSON.stringify(evalCase({ new_metric: 0.9 }))]);
    expect(d.unknownFields).toEqual({ new_metric: 1 });
    expect(d.linesSkipped).toBe(0);
  });

  it("never throws for a file with no readable lines", () => {
    const r = parseEvalFileDetailed("empty.jsonl", ["", "nope"]);
    expect(r.parsed).toBeNull();
    expect(r.nonBlankLines).toBe(1);
    expect(r.invalidCount).toBe(1);
  });
});
