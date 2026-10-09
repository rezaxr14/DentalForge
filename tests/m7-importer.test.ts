import { describe, expect, it } from "vitest";
import {
  traceFileMeta,
  contentHashOf,
  parseTraceLine,
  parseEvalFile,
} from "@/shared/lib/import/parse";
import { fixtureSource } from "@/shared/lib/datasource";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { emptyStats } from "@/shared/lib/import/db";

describe("M7: Importer parsing and deduplication", () => {
  it("parses traceFileMeta correctly for per-cohort files", () => {
    const dentexWithTools = traceFileMeta("train_cot_traces_dentex.jsonl");
    expect(dentexWithTools).toEqual({
      cohort: "dentex",
      mode: "with_tools",
      verified: true,
      priority: 0,
    });

    const dentexNoTools = traceFileMeta("train_cot_traces_dentex_no_tools.jsonl");
    expect(dentexNoTools).toEqual({
      cohort: "dentex",
      mode: "no_tools",
      verified: true,
      priority: 0,
    });

    const healthyTufts = traceFileMeta("train_cot_traces_healthy_tufts.jsonl");
    expect(healthyTufts).toEqual({
      cohort: "healthy_tufts",
      mode: "with_tools",
      verified: true,
      priority: 0,
    });

    const unverified = traceFileMeta("train_cot_traces_unverified_dentex.jsonl");
    expect(unverified).toEqual({
      cohort: "dentex",
      mode: "with_tools",
      verified: false,
      priority: 0,
    });
  });

  it("assigns priority 2 (skip) to hybrid union files", () => {
    const hybridWithTools = traceFileMeta("train_cot_traces.jsonl");
    expect(hybridWithTools).toEqual({
      cohort: "hybrid",
      mode: "with_tools",
      verified: true,
      priority: 2,
    });

    const hybridNoTools = traceFileMeta("train_cot_traces_no_tools.jsonl");
    expect(hybridNoTools).toEqual({
      cohort: "hybrid",
      mode: "no_tools",
      verified: true,
      priority: 2,
    });
  });

  it("computes deterministic contentHashOf", () => {
    const line = '{"image_id": 42, "dataset": "dentex"}';
    const hash1 = contentHashOf(line);
    const hash2 = contentHashOf(line + "  \n");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("parses a valid trace line and counts turns and tool calls", () => {
    const meta = traceFileMeta("train_cot_traces_dentex.jsonl");
    const rawLine = JSON.stringify({
      image_id: 101,
      image_path: "/data/img101.png",
      dataset: "dentex",
      ground_truth: [{ quadrant: 1, tooth_position: 6, diagnosis: "Caries" }],
      turns: [
        {
          turn: 1,
          raw_output: "Let me check tooth 16",
          parsed: {
            thought: "Checking tooth 16",
            tool_calls: [{ tool: "locate_tooth", args: { tooth: 16 } }],
          },
          status: "tool_executed",
          tool_calls_this_turn: [
            {
              tool_name: "locate_tooth",
              tool_args: { tooth: 16 },
              tool_ok: true,
            },
          ],
        },
        {
          turn: 2,
          raw_output: "Found Caries",
          parsed: {
            thought: "Diagnosis confirmed",
            final_answer: [{ quadrant: 1, tooth_position: 6, diagnosis: "Caries" }],
          },
          status: "final_answer",
        },
      ],
      tool_calls: 1,
      final_answer: [{ quadrant: 1, tooth_position: 6, diagnosis: "Caries" }],
      messages: [],
      format_ok: true,
    });

    const parsed = parseTraceLine(rawLine, "train_cot_traces_dentex.jsonl", meta);
    expect(parsed).not.toBeNull();
    expect(parsed?.sourceImageId).toBe(101);
    expect(parsed?.dataset).toBe("dentex");
    expect(parsed?.cohort).toBe("dentex");
    expect(parsed?.mode).toBe("with_tools");
    expect(parsed?.nTurns).toBe(2);
    expect(parsed?.nToolCalls).toBe(1);
    expect(parsed?.formatOk).toBe(true);
    expect(parsed?.turns[0]?.toolCalls).toHaveLength(1);
    expect(parsed?.turns[0]?.toolCalls[0]?.toolName).toBe("locate_tooth");
  });

  it("handles model dumping final_answer in tool_calls slot without error (ADR-0008 reality override)", () => {
    const meta = traceFileMeta("train_cot_traces_dentex.jsonl");
    const rawLine = JSON.stringify({
      image_id: 202,
      image_path: "",
      dataset: "dentex",
      ground_truth: [],
      turns: [
        {
          turn: 1,
          raw_output: "Final answer dump",
          parsed: {
            // Irregular: object with final_answer where {tool, args} is expected
            tool_calls: [
              {
                thought: "Done",
                final_answer: [{ quadrant: 3, tooth_position: 8, diagnosis: "Impacted" }],
              },
            ],
          },
          status: "multi_blob_dump",
        },
      ],
      tool_calls: 0,
      final_answer: [],
      messages: [],
      format_ok: true,
    });

    const parsed = parseTraceLine(rawLine, "train_cot_traces_dentex.jsonl", meta);
    expect(parsed).not.toBeNull();
    expect(parsed?.nTurns).toBe(1);
  });

  it("returns null for invalid JSON or schema violations", () => {
    const meta = traceFileMeta("train_cot_traces_dentex.jsonl");
    expect(parseTraceLine("not valid json", "test.jsonl", meta)).toBeNull();
    expect(parseTraceLine("{}", "test.jsonl", meta)).toBeNull();
  });

  it("parses eval file and computes summary means across all cases", () => {
    const lines = [
      JSON.stringify({
        image_id: 1,
        dataset: "dentex",
        split: "val",
        provider: "qwen",
        model: "qwen-2.5",
        ground_truth: [{ quadrant: 1, tooth_position: 1, diagnosis: "Caries" }],
        predictions: [{ quadrant: 1, tooth_position: 1, diagnosis: "Caries", confidence: 0.9 }],
        matched_pairs: [],
        fdi_precision: 1,
        fdi_recall: 1,
        fdi_f1: 1.0,
        exact_precision: 1,
        exact_recall: 1,
        exact_f1: 1.0,
        closeness_score: 0.8,
        spatial_proximity: 0.8,
        diagnostic_similarity: 1.0,
        fdi_correct: true,
        quadrant_correct: true,
        tooth_position_correct: true,
        diagnosis_correct: true,
        exact_match: true,
        all_exact_match: true,
        raw_output: "Q11 Caries",
        format_ok: true,
        finish_reason: "stop",
      }),
      JSON.stringify({
        image_id: 2,
        dataset: "dentex",
        split: "val",
        provider: "qwen",
        model: "qwen-2.5",
        ground_truth: [{ quadrant: 2, tooth_position: 1, diagnosis: "Caries" }],
        predictions: [{ quadrant: 2, tooth_position: 2, diagnosis: "Caries", confidence: 0.5 }],
        matched_pairs: [],
        fdi_precision: 0,
        fdi_recall: 0,
        fdi_f1: 0.0,
        exact_precision: 0,
        exact_recall: 0,
        exact_f1: 0.0,
        closeness_score: 0.4,
        spatial_proximity: 0.4,
        diagnostic_similarity: 1.0,
        fdi_correct: false,
        quadrant_correct: true,
        tooth_position_correct: false,
        diagnosis_correct: true,
        exact_match: false,
        all_exact_match: false,
        raw_output: "Q22 Caries",
        format_ok: false,
        finish_reason: "stop",
      }),
    ];

    const result = parseEvalFile("zero_shot_dentex_val_qwen_qwen-2.5.jsonl", lines);
    expect(result).not.toBeNull();
    expect(result?.run.n).toBe(2);
    expect(result?.run.model).toBe("qwen-2.5");
    expect(result?.run.summary.exact_f1).toBeCloseTo(0.5);
    expect(result?.run.summary.fdi_f1).toBeCloseTo(0.5);
    expect(result?.run.summary.closeness).toBeCloseTo(0.6);
    expect(result?.run.summary.format_ok_rate).toBeCloseTo(0.5);
    expect(result?.cases).toHaveLength(2);
  });
});

describe("M7: DataSource abstraction", () => {
  it("fixtureSource returns traces with provenance 'fixture'", async () => {
    const src = fixtureSource();
    expect(src.provenance).toBe("fixture");
    const traces = await src.listTraces();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.provenance).toBe("fixture");

    const verified = traces.find((t) => t.verified);
    expect(verified).toBeDefined();
    const detail = await src.getTraceDetail(verified!.id);
    expect(detail).not.toBeNull();
    expect(detail?.provenance).toBe("fixture");
    expect(detail?.trace.image_id).toBeDefined();

    const missing = await src.getTraceDetail("nonexistent-id-9999");
    expect(missing).toBeNull();
  });

  it("fixtureSource returns eval runs and cases with provenance 'fixture'", async () => {
    const src = fixtureSource();
    const runs = await src.listEvalRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.provenance).toBe("fixture");

    const evalCase = await src.getEvalCase(runs[0]!.id);
    expect(evalCase).not.toBeNull();
    expect(evalCase?.provenance).toBe("fixture");
    expect(evalCase?.evalCase.model).toBeDefined();

    const missing = await src.getEvalCase("nonexistent-id-9999");
    expect(missing).toBeNull();
  });

  it("resolveDataSource defaults to fixtureSource when TRACEFORGE_DATASOURCE is unset", async () => {
    delete process.env.TRACEFORGE_DATASOURCE;
    const { source, fallbackReason } = await resolveDataSource();
    expect(source.provenance).toBe("fixture");
    expect(fallbackReason).toBeNull();
  });

  it("resolveDataSource gracefully falls back to fixtureSource if postgres is unreachable", async () => {
    process.env.TRACEFORGE_DATASOURCE = "postgres";
    const { source, fallbackReason } = await resolveDataSource();
    expect(source.provenance).toBe("fixture");
    expect(fallbackReason).toBeTruthy();
    delete process.env.TRACEFORGE_DATASOURCE;
  });

  it("emptyStats initializes all counters to 0", () => {
    const stats = emptyStats("org-123");
    expect(stats.orgId).toBe("org-123");
    expect(stats.tracesInserted).toBe(0);
    expect(stats.imagesInserted).toBe(0);
    expect(stats.evalRunsInserted).toBe(0);
    expect(stats.invalidLines).toBe(0);
  });
});
