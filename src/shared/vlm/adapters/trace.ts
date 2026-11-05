/**
 * Tolerant, versioned readers for VLM-DENTAL data shapes (ADR-0024).
 *
 * The app must never break because VLM-DENTAL moved. Every reader here:
 *  - keeps unknown fields instead of dropping them (`extra` + schema `.passthrough()`),
 *  - defaults missing OPTIONAL fields,
 *  - counts a line it cannot read and reports why, instead of throwing,
 *  - records the adapter version that produced the row.
 *
 * When upstream changes a shape, add a NEW adapter version here and leave the old one intact. Do not
 * edit core importer code to chase a field rename.
 */
import { createHash } from "node:crypto";
import { EvalCase, VerifiedTrace, type EvalCaseT } from "@/shared/contracts/traces";
import type { AdapterDiagnostics } from "./types";

export const TRACE_ADAPTER_VERSION = "trace.v1";
export const EVAL_ADAPTER_VERSION = "eval.v1";

/** What a reader saw, aggregated. Printed by `pnpm diagnose:data`; never used to change behaviour. */


/** How many skipped lines are kept verbatim for diagnostics (the count itself is always exact). */
export const MAX_SKIP_SAMPLES = 20;

/** Back-compat alias: the eval reader's `invalid` list keeps the first 20 rejected lines. */
export const MAX_INVALID_SAMPLES = MAX_SKIP_SAMPLES;

export function newDiagnostics(adapter: string, version: string): AdapterDiagnostics {
  return { adapter, version, linesRead: 0, linesSkipped: 0, unknownFields: {}, variants: {}, skipped: [] };
}

export function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function skip(d: AdapterDiagnostics, line: number, reason: string): void {
  d.linesSkipped += 1;
  if (d.skipped.length < MAX_SKIP_SAMPLES) d.skipped.push({ line, reason });
}

/** Top-level (and one nested level) unknown keys, counted by dotted path. */
export function collectUnknownFields(
  value: unknown,
  known: ReadonlySet<string>,
  prefix = "",
  into: Record<string, number> = {},
): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return into;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!known.has(path)) bump(into, path);
  }
  return into;
}

/** sha256 over the trimmed raw line — stable across re-reads of the file. */
export function contentHashOf(rawLine: string): string {
  return createHash("sha256").update(rawLine.trim()).digest("hex");
}

// --------------------------------------------------------------------------- trace

export interface TraceFileMeta {
  cohort: string;
  mode: "with_tools" | "no_tools";
  verified: boolean;
  /** Lower = processed first and wins the dedupe. */
  priority: number;
}

const KNOWN_COHORTS = ["dentex", "healthy_dentex", "tufts", "healthy_tufts", "tufts_all"];

/** `train_cot_traces_healthy_dentex_no_tools.jsonl` → cohort/mode/verified. */
export function traceFileMeta(fileName: string): TraceFileMeta {
  let base = fileName.replace(/\.jsonl$/, "");
  let verified = true;
  if (base.startsWith("train_cot_traces_unverified_")) {
    verified = false;
    base = base.replace("train_cot_traces_unverified_", "");
  } else if (base === "train_cot_traces") {
    base = ""; // hybrid union file, with_tools
  } else if (base === "train_cot_traces_no_tools") {
    base = "_no_tools"; // hybrid union file, no_tools — falls through below
  } else {
    base = base.replace("train_cot_traces_", "");
  }
  let mode: TraceFileMeta["mode"] = "with_tools";
  if (base.endsWith("_no_tools")) {
    mode = "no_tools";
    base = base.replace(/_no_tools$/, "");
  }
  const cohort = base === "" ? "hybrid" : base;
  const priority = cohort === "hybrid" ? 2 : KNOWN_COHORTS.includes(cohort) ? 0 : 1;
  return { cohort, mode, verified, priority };
}

export interface ParsedTurn {
  idx: number;
  status: string;
  thought: string | null;
  rawOutput: string | null;
  parsed: unknown;
  toolCalls: {
    idx: number;
    toolName: string;
    args: Record<string, unknown>;
    ok: boolean;
    error: string | null;
    trueBbox: unknown;
    perturbTier: string | null;
    artifactId?: string | null;
  }[];
}

export interface ParsedTraceRow {
  dataset: string;
  sourceImageId: number;
  cohort: string;
  mode: "with_tools" | "no_tools";
  verified: boolean;
  sourceFile: string;
  contentHash: string;
  nTurns: number;
  nToolCalls: number;
  formatOk: boolean;
  verifierReason: string | null;
  groundTruth: unknown;
  finalAnswer: unknown;
  turns: ParsedTurn[];
  /** Adapter version that produced this row (stored on the imported trace row). */
  adapterVersion: string;
  /** Unknown top-level fields, kept instead of dropped. */
  extra: Record<string, unknown>;
}

const TRACE_KNOWN_FIELDS = new Set([
  "image_id",
  "image_path",
  "dataset",
  "ground_truth",
  "turns",
  "tool_calls",
  "final_answer",
  "messages",
  "format_ok",
  "verifier_reason",
  "assistant_token_spans",
  "status",
  "failure_reason",
  "partial_trajectory",
  "trajectory",
]);

const TURN_KNOWN_FIELDS = new Set([
  "turn",
  "raw_output",
  "parsed",
  "status",
  "tool_calls_this_turn",
  "assistant_token_spans",
]);

const CALL_KNOWN_FIELDS = new Set([
  "tool_name",
  "tool_args",
  "tool_ok",
  "tool_error",
  "true_bbox",
  "perturb_tier",
  "artifact_id",
  "result",
]);

const FINDING_KNOWN_FIELDS = new Set(["quadrant", "tooth_position", "diagnosis", "raw_diagnosis", "confidence", "bbox"]);

function extraFields(value: unknown, known: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!known.has(k)) out[k] = v;
  return out;
}

export interface TraceReadResult {
  row: ParsedTraceRow | null;
  /** Why the line was skipped (null when it parsed). */
  reason: string | null;
}

/**
 * Parse one verified-trace JSONL line. Returns `{ row: null, reason }` for lines that fail the
 * M0-validated contract (counted by callers, never inserted, never thrown).
 */
export function readTraceLine(
  rawLine: string,
  file: string,
  meta: TraceFileMeta,
  diagnostics?: AdapterDiagnostics,
): TraceReadResult {
  const d = diagnostics;
  let json: unknown;
  try {
    json = JSON.parse(rawLine);
  } catch {
    if (d) skip(d, d.linesRead, "not valid JSON");
    return { row: null, reason: "not valid JSON" };
  }
  const parsed = VerifiedTrace.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 3).join("; ");
    if (d) skip(d, d.linesRead, reason);
    return { row: null, reason };
  }
  const t = parsed.data;

  if (d) {
    bump(d.variants, `dataset=${t.dataset}`);
    bump(d.variants, `tool_calls=${typeof t.tool_calls === "number" ? "number" : "array"}`);
    for (const [path, count] of Object.entries(collectUnknownFields(json, TRACE_KNOWN_FIELDS))) {
      d.unknownFields[path] = (d.unknownFields[path] ?? 0) + count;
    }
    for (const turn of (json as { turns?: unknown[] }).turns ?? []) {
      for (const [path, count] of Object.entries(collectUnknownFields(turn, TURN_KNOWN_FIELDS, "turns[]"))) {
        d.unknownFields[path] = (d.unknownFields[path] ?? 0) + count;
      }
      bump(d.variants, `turns[].status=${turn && typeof turn === "object" && "status" in turn ? "present" : "absent"}`);
    }
  }

  const turns: ParsedTurn[] = t.turns.map((raw) => {
    const turn = raw as typeof raw;
    const p = turn.parsed as { thought?: unknown } | null | undefined;
    const thought = typeof p?.thought === "string" ? p.thought : null;
    return {
      idx: turn.turn,
      status: turn.status ?? "",
      thought,
      rawOutput: turn.raw_output ?? null,
      parsed: turn.parsed ?? null,
      toolCalls: (turn.tool_calls_this_turn ?? []).map((c, i) => {
        if (d) {
          for (const [path, count] of Object.entries(collectUnknownFields(c, CALL_KNOWN_FIELDS, "turns[].tool_calls_this_turn[]"))) {
            d.unknownFields[path] = (d.unknownFields[path] ?? 0) + count;
          }
        }
        return {
          idx: i,
          toolName: c.tool_name,
          args: c.tool_args,
          ok: c.tool_ok,
          error: c.tool_error ?? null,
          trueBbox: c.true_bbox ?? null,
          perturbTier: c.perturb_tier ?? null,
          artifactId: c.artifact_id ?? null,
        };
      }),
    };
  });

  if (d) {
    for (const gt of (Array.isArray(t.ground_truth) ? t.ground_truth : [])) {
      for (const [path, count] of Object.entries(collectUnknownFields(gt, FINDING_KNOWN_FIELDS, "ground_truth[]"))) {
        d.unknownFields[path] = (d.unknownFields[path] ?? 0) + count;
      }
    }
  }

  const nToolCalls =
    typeof t.tool_calls === "number" ? t.tool_calls : turns.reduce((n, turn) => n + turn.toolCalls.length, 0);

  return {
    row: {
      dataset: t.dataset,
      sourceImageId: t.image_id,
      cohort: meta.cohort,
      mode: meta.mode,
      verified: meta.verified,
      sourceFile: file,
      contentHash: contentHashOf(rawLine),
      nTurns: turns.length,
      nToolCalls,
      formatOk: t.format_ok,
      verifierReason: t.verifier_reason ?? null,
      groundTruth: t.ground_truth,
      finalAnswer: t.final_answer,
      turns,
      adapterVersion: TRACE_ADAPTER_VERSION,
      extra: extraFields(json, TRACE_KNOWN_FIELDS),
    },
    reason: null,
  };
}

/** Backwards-compatible wrapper: the M7 importer's original signature. */
export function parseTraceLine(rawLine: string, file: string, meta: TraceFileMeta): ParsedTraceRow | null {
  return readTraceLine(rawLine, file, meta).row;
}

/** Read a whole file for diagnostics only (counts, unknown fields, shape variants). Never throws. */
export function scanTraceLines(lines: string[], file: string, meta: TraceFileMeta): AdapterDiagnostics {
  const d = newDiagnostics("trace", TRACE_ADAPTER_VERSION);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    d.linesRead += 1;
    readTraceLine(trimmed, file, meta, d);
  }
  return d;
}

// --------------------------------------------------------------------------- eval

export interface ParsedEval {
  run: {
    dataset: string;
    split: string;
    provider: string;
    model: string;
    n: number;
    sourceFile: string;
    /** Means computed from the file — never hard-coded (plan §0 rule 3). */
    summary: Record<string, number>;
    /** Adapter version that produced this run (stored on the imported eval run). */
    adapterVersion: string;
  };
  cases: {
    sourceImageId: number;
    groundTruth: unknown;
    predictions: unknown;
    matchedPairs: unknown;
    fdiF1: number;
    exactF1: number;
    closeness: number;
    spatial: number;
    diagSim: number;
    confidence: number | null;
    formatOk: boolean;
    rawOutput: string;
  }[];
}

export interface EvalMetricRow {
  fdiF1: number;
  exactF1: number;
  closeness: number;
  spatial: number;
  diagSim: number;
  formatOk: boolean;
}

/** THE run summary: means over `rows`, in the given order (plan §0 rule 3: computed, never hard-coded). */
export function summarizeEval(rows: EvalMetricRow[]): Record<string, number> {
  if (rows.length === 0) return {};
  const sum = { fdi_f1: 0, exact_f1: 0, closeness: 0, spatial: 0, diag_sim: 0 };
  let formatOkCount = 0;
  for (const r of rows) {
    sum.fdi_f1 += r.fdiF1;
    sum.exact_f1 += r.exactF1;
    sum.closeness += r.closeness;
    sum.spatial += r.spatial;
    sum.diag_sim += r.diagSim;
    if (r.formatOk) formatOkCount += 1;
  }
  const n = rows.length;
  return {
    fdi_f1: sum.fdi_f1 / n,
    exact_f1: sum.exact_f1 / n,
    closeness: sum.closeness / n,
    spatial: sum.spatial / n,
    diag_sim: sum.diag_sim / n,
    format_ok_rate: formatOkCount / n,
  };
}

export function evalCaseRow(c: EvalCaseT): ParsedEval["cases"][number] {
  return {
    sourceImageId: c.image_id,
    groundTruth: c.ground_truth,
    predictions: c.predictions,
    matchedPairs: c.matched_pairs,
    fdiF1: c.fdi_f1,
    exactF1: c.exact_f1,
    closeness: c.closeness_score,
    spatial: c.spatial_proximity,
    diagSim: c.diagnostic_similarity,
    confidence: c.confidence ?? null,
    formatOk: c.format_ok,
    rawOutput: c.raw_output,
  };
}

export interface EvalLineProblem {
  line: number;
  issues: string[];
}

export interface ParsedEvalFile {
  parsed: ParsedEval | null;
  nonBlankLines: number;
  invalidCount: number;
  invalid: EvalLineProblem[];
  diagnostics: AdapterDiagnostics;
}

const EVAL_KNOWN_FIELDS = new Set([
  "image_id",
  "dataset",
  "split",
  "provider",
  "model",
  "ground_truth",
  "predictions",
  "matched_pairs",
  "fdi_precision",
  "fdi_recall",
  "fdi_f1",
  "exact_precision",
  "exact_recall",
  "exact_f1",
  "closeness_score",
  "spatial_proximity",
  "diagnostic_similarity",
  "fdi_correct",
  "quadrant_correct",
  "tooth_position_correct",
  "diagnosis_correct",
  "exact_match",
  "all_exact_match",
  "final_answer",
  "raw_output",
  "format_ok",
  "finish_reason",
  "confidence",
  "timestamp",
]);

/**
 * Like `parseEvalFile`, but says what it skipped. Skipping is still how a file is imported (one bad
 * line must not block the rest), yet it must never be SILENT: dropping cases changes every mean in
 * the summary (ADR-0014).
 */
export function parseEvalFileDetailed(fileName: string, lines: string[]): ParsedEvalFile {
  const diagnostics = newDiagnostics("eval", EVAL_ADAPTER_VERSION);
  const cases: ParsedEval["cases"] = [];
  let run: ParsedEval["run"] | null = null;
  let nonBlankLines = 0;
  let invalidCount = 0;
  const invalid: EvalLineProblem[] = [];
  const reject = (line: number, issues: string[]) => {
    invalidCount += 1;
    if (invalid.length < MAX_INVALID_SAMPLES) invalid.push({ line, issues: issues.slice(0, 3) });
    skip(diagnostics, line, issues.join("; "));
  };

  for (const [i, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    nonBlankLines += 1;
    diagnostics.linesRead += 1;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      reject(i + 1, ["not valid JSON"]);
      continue;
    }
    const c = EvalCase.safeParse(json);
    if (!c.success) {
      reject(
        i + 1,
        c.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`),
      );
      continue;
    }
    for (const [path, count] of Object.entries(collectUnknownFields(json, EVAL_KNOWN_FIELDS))) {
      diagnostics.unknownFields[path] = (diagnostics.unknownFields[path] ?? 0) + count;
    }
    bump(diagnostics.variants, `dataset=${c.data.dataset}`);
    bump(diagnostics.variants, `confidence=${c.data.confidence == null ? "nullish" : "number"}`);
    if (!run) {
      run = {
        dataset: c.data.dataset,
        split: c.data.split,
        provider: c.data.provider,
        model: c.data.model,
        n: 0,
        sourceFile: fileName,
        summary: {},
        adapterVersion: EVAL_ADAPTER_VERSION,
      };
    }
    run.n += 1;
    cases.push(evalCaseRow(c.data));
  }

  if (!run || run.n === 0) return { parsed: null, nonBlankLines, invalidCount, invalid, diagnostics };
  run.summary = summarizeEval(cases);
  return { parsed: { run, cases }, nonBlankLines, invalidCount, invalid, diagnostics };
}

export function parseEvalFile(fileName: string, lines: string[]): ParsedEval | null {
  return parseEvalFileDetailed(fileName, lines).parsed;
}

/** Read a whole eval file for diagnostics only. Never throws. */
export function scanEvalLines(fileName: string, lines: string[]): AdapterDiagnostics {
  return parseEvalFileDetailed(fileName, lines).diagnostics;
}
