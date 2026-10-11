/**
 * M7 importer — pure parsing/dedup layer (plan §4.3, §13 M7).
 *
 * Reads REAL VLM-DENTAL JSONL (read-only, plan §0 rule 2: reality wins)
 * and turns each line into insert-ready rows. No DB access here so the
 * dedupe logic is unit-testable without Postgres.
 *
 * Dedupe (plan §4.3): identity key (dataset, image_id, cohort, mode) plus a
 * content hash over the raw line. Per-cohort files are canonical (priority 0)
 * so their cohort label wins over the hybrid files (priority 1), which
 * duplicate them.
 */
import { createHash } from "node:crypto";
import { EvalCase, type EvalCaseT, Turn, VerifiedTrace } from "@/shared/contracts/traces";

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
  // Hybrid union files (train_cot_traces{,_no_tools}.jsonl) duplicate the
  // per-cohort files byte-for-byte — the IMPORTER SKIPS THEM AT FILE LEVEL
  // (priority 2); they only exist here so meta parsing stays total.
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
}

/** sha256 over the trimmed raw line — stable across re-reads of the file. */
export function contentHashOf(rawLine: string): string {
  return createHash("sha256").update(rawLine.trim()).digest("hex");
}

/**
 * Parse one verified-trace JSONL line. Returns null for lines that fail the
 * M0-validated contract (counted as `invalid` by callers, never inserted).
 */
export function parseTraceLine(
  rawLine: string,
  file: string,
  meta: TraceFileMeta,
): ParsedTraceRow | null {
  let json: unknown;
  try {
    json = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const parsed = VerifiedTrace.safeParse(json);
  if (!parsed.success) return null;
  const t = parsed.data;

  const turns: ParsedTurn[] = t.turns.map((raw) => {
    const turn = Turn.parse(raw);
    const p = turn.parsed as { thought?: unknown } | null | undefined;
    const thought = typeof p?.thought === "string" ? p.thought : null;
    return {
      idx: turn.turn,
      status: turn.status ?? "",
      thought,
      rawOutput: turn.raw_output ?? null,
      parsed: turn.parsed ?? null,
      toolCalls: (turn.tool_calls_this_turn ?? []).map((c, i) => ({
        idx: i,
        toolName: c.tool_name,
        args: c.tool_args,
        ok: c.tool_ok,
        error: c.tool_error ?? null,
        trueBbox: c.true_bbox ?? null,
        perturbTier: c.perturb_tier ?? null,
      })),
    };
  });

  const nToolCalls =
    typeof t.tool_calls === "number"
      ? t.tool_calls
      : turns.reduce((n, turn) => n + turn.toolCalls.length, 0);

  return {
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
  };
}

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
  };
  cases: {
    sourceImageId: number;
    groundTruth: unknown;
    predictions: unknown;
    matchedPairs: unknown;
    fdiF1: number;
    exactF1: number;
    closeness: number;
    /** spatial_proximity / diagnostic_similarity: summarized, and stored by `ingest/eval-run` (not by file imports). */
    spatial: number;
    diagSim: number;
    confidence: number | null;
    formatOk: boolean;
    rawOutput: string;
  }[];
}

/**
 * Parse one zero-shot eval JSONL file (one run per file, plan §4.5).
 * Returns null when no line validates — callers skip with a warning.
 * Summary means are COMPUTED over all cases (never hard-coded, §0 rule 3).
 */
/** The per-case numbers a run summary is a mean of. */
export interface EvalMetricRow {
  fdiF1: number;
  exactF1: number;
  closeness: number;
  spatial: number;
  diagSim: number;
  formatOk: boolean;
}

/**
 * THE run summary: means over `rows`, in the given order (plan §0 rule 3: computed, never hard-coded).
 * Used by `parseEvalFile` (file imports) and by `ingest/eval-run` (recomputed from all stored cases), so the two
 * paths cannot disagree. `{}` for no rows.
 */
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

/** One validated eval case → the stored row shape. Shared by file imports and `ingest/eval-run`. */
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

/** A non-blank line that could not be used, with the first few reasons (`path: message`). */
export interface EvalLineProblem {
  /** 1-based line number in the file. */
  line: number;
  issues: string[];
}

export interface ParsedEvalFile {
  parsed: ParsedEval | null;
  /** Non-blank lines in the file. */
  nonBlankLines: number;
  /** Lines that were not valid JSON or did not satisfy `EvalCase`. They are NOT in `parsed`. */
  invalidCount: number;
  /** The first {@link MAX_INVALID_SAMPLES} of them. */
  invalid: EvalLineProblem[];
}

export const MAX_INVALID_SAMPLES = 20;

/**
 * Like `parseEvalFile`, but says what it skipped. Skipping is still how a file is imported (one bad line must not
 * block the rest), yet it must never be SILENT: dropping cases changes every mean in the summary (ADR-0014).
 */
export function parseEvalFileDetailed(fileName: string, lines: string[]): ParsedEvalFile {
  const cases: ParsedEval["cases"] = [];
  let run: ParsedEval["run"] | null = null;
  let nonBlankLines = 0;
  let invalidCount = 0;
  const invalid: EvalLineProblem[] = [];
  const reject = (line: number, issues: string[]) => {
    invalidCount += 1;
    if (invalid.length < MAX_INVALID_SAMPLES) invalid.push({ line, issues: issues.slice(0, 3) });
  };

  for (const [i, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    nonBlankLines += 1;
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
    if (!run) {
      run = {
        dataset: c.data.dataset,
        split: c.data.split,
        provider: c.data.provider,
        model: c.data.model,
        n: 0,
        sourceFile: fileName,
        summary: {},
      };
    }
    run.n += 1;
    cases.push(evalCaseRow(c.data));
  }

  if (!run || run.n === 0) return { parsed: null, nonBlankLines, invalidCount, invalid };
  run.summary = summarizeEval(cases);
  return { parsed: { run, cases }, nonBlankLines, invalidCount, invalid };
}

export function parseEvalFile(fileName: string, lines: string[]): ParsedEval | null {
  return parseEvalFileDetailed(fileName, lines).parsed;
}

