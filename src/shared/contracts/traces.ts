import { z } from "zod";

/**
 * M0-validated domain schemas for TraceForge.
 *
 * Validated against real VLM-DENTAL files (read-only):
 * - data/traces/train_cot_traces*.jsonl (verified)
 * - data/traces/train_cot_traces_unverified_*.jsonl
 * - data/evaluations/zero_shot_*.jsonl
 *
 * CORRECTIONS vs TRACEFORGE_IMPLEMENTATION_PLAN §4.3 draft:
 * 1. `Turn.status` is OPTIONAL — single-turn no-tools traces have NO status key.
 * 2. `Turn.raw_output` / `Turn.parsed` are OPTIONAL — tool-execution turns
 *    (status=tool_executed, the majority: 2247/2481 in a 200-line sample)
 *    carry ONLY {turn, tool_calls_this_turn, status}. Only terminal turns
 *    (final_answer / rejected / unparseable / invalid_tool_format) carry
 *    raw_output + parsed.
 * 3. `ToolCallRecord` has NO `tool_error` in real data (error counter was 0
 *    over 2663 sampled calls) and NO extra keys beyond the 5 known ones.
 *    Kept as optional for forward-compat; `.passthrough()` retained anyway.
 * 4. `Finding` in eval records carries `raw_diagnosis` alongside the
 *    normalized `diagnosis` — the plan's §4.2 mentions storing both but the
 *    §4.3 Finding draft omitted `raw_diagnosis`. Added as optional.
 * 5. Real `Finding.diagnosis` values include "Impacted Tooth" and
 *    "Deep Caries" variants alongside "Impacted" — normalization
 *    (normalize_dental_diagnosis) is an Eval-Hub port task, not a schema
 *    constraint; diagnosis stays a plain string here.
 */

/** [x, y, w, h] in native image pixels. Never canvas coordinates. */
export const Bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const Finding = z
  .object({
    quadrant: z.number().int().min(1).max(4),
    tooth_position: z.number().int().min(1).max(8),
    diagnosis: z.string(),
    /** Raw model/dataset string before normalization (eval records). */
    raw_diagnosis: z.string().optional(),
    /** Present on predictions; absent on ground truth. */
    confidence: z.number().min(0).max(1).optional(),
    /** Present on ground truth; absent on predictions. */
    bbox: Bbox.optional(),
  })
  .passthrough();

export const ToolCallRecord = z
  .object({
    tool_name: z.string(),
    tool_args: z.record(z.string(), z.unknown()),
    tool_ok: z.boolean(),
    tool_error: z.string().optional(),
    /** Only when a perturbation fired (locate_tooth audit). */
    true_bbox: Bbox.optional(),
    perturb_tier: z.enum(["small", "big"]).optional(),
  })
  .passthrough();

/**
 * Model-emitted tool_calls inside `parsed`. REALITY OVERRIDE (plan §0 rule 2,
 * ADR-0008): some traces store a `{thought, final_answer}` blob in the
 * tool_calls slot (4 lines in the per-cohort files) — the model dumped its
 * final answer where a tool call was expected. `tool`/`args` are therefore
 * OPTIONAL; consumers skip entries without a `tool` name.
 */
const ParsedToolCall = z
  .object({
    tool: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const Turn = z
  .object({
    turn: z.number().int(),
    /** Absent on tool-execution turns; present on terminal turns. */
    raw_output: z.string().optional(),
    /** Absent on tool-execution turns; null when unparseable. */
    parsed: z
      .object({
        thought: z.string().optional(),
        tool_calls: z.array(ParsedToolCall).optional(),
        final_answer: z.array(Finding).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    /** Absent on single-turn no-tools traces. */
    status: z.string().optional(),
    tool_calls_this_turn: z.array(ToolCallRecord).optional(),
  })
  .passthrough();

export const VerifiedTrace = z
  .object({
    image_id: z.number().int(),
    /** Machine-specific (Kaggle/Colab/Windows). NEVER use to locate images. */
    image_path: z.string(),
    dataset: z.string().default("dentex"),
    /** [] for healthy scans. */
    ground_truth: z.array(Finding),
    turns: z.array(Turn),
    /**
     * REAL QUIRK: with-tools files store an INT total count (e.g. 42);
     * no-tools files store an EMPTY LIST []. Accept both.
     */
    tool_calls: z.union([z.number().int(), z.array(z.unknown())]),
    final_answer: z.array(Finding).nullable(),
    messages: z.array(z.unknown()),
    format_ok: z.boolean(),
    verifier_reason: z.string().optional(),
  })
  .passthrough();

/** Unverified wrapper: trajectory nested, tagged verified=false on import. */
export const UnverifiedTraceWrapper = z
  .object({
    image_id: z.number().int(),
    image_path: z.string(),
    ground_truth: z.array(Finding),
    status: z.enum(["unverified", "generation_failed"]),
    trajectory: z.unknown().optional(),
    failure_reason: z.unknown().optional(),
    partial_trajectory: z.unknown().optional(),
  })
  .passthrough();

export const MatchedPair = z
  .object({
    gt: Finding,
    pred: Finding,
    fdi_match: z.boolean(),
    exact_match: z.boolean(),
    closeness: z.number(),
    spatial: z.number(),
    diag_sim: z.number(),
  })
  .passthrough();

export const EvalCase = z
  .object({
    image_id: z.number().int(),
    dataset: z.string(),
    split: z.string(),
    provider: z.string(),
    model: z.string(),
    ground_truth: z.array(Finding),
    predictions: z.array(Finding),
    matched_pairs: z.array(MatchedPair),
    fdi_precision: z.number(),
    fdi_recall: z.number(),
    fdi_f1: z.number(),
    exact_precision: z.number(),
    exact_recall: z.number(),
    exact_f1: z.number(),
    closeness_score: z.number(),
    spatial_proximity: z.number(),
    diagnostic_similarity: z.number(),
    fdi_correct: z.boolean(),
    quadrant_correct: z.boolean(),
    tooth_position_correct: z.boolean(),
    diagnosis_correct: z.boolean(),
    exact_match: z.boolean(),
    all_exact_match: z.boolean(),
    final_answer: z.unknown().optional(),
    raw_output: z.string(),
    format_ok: z.boolean(),
    finish_reason: z.string(),
    confidence: z.number().optional(),
    /** Unix epoch float in real files (e.g. 1788418771.41), not ISO string. */
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type BboxT = z.infer<typeof Bbox>;
export type FindingT = z.infer<typeof Finding>;
export type ToolCallRecordT = z.infer<typeof ToolCallRecord>;
export type TurnT = z.infer<typeof Turn>;
export type VerifiedTraceT = z.infer<typeof VerifiedTrace>;
export type EvalCaseT = z.infer<typeof EvalCase>;
