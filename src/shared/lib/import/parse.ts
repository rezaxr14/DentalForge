/**
 * M7 importer — parsing/dedup layer (plan §4.3, §13 M7).
 *
 * The readers now live in the versioned adapter layer (`src/shared/vlm/adapters/`, ADR-0024). This
 * module is kept as the importer's stable import surface: every symbol the M7 importer and its tests
 * used is re-exported unchanged, so refactoring readers into adapters was behaviour-preserving.
 */
export {
  contentHashOf,
  evalCaseRow,
  parseEvalFile,
  parseEvalFileDetailed,
  parseTraceLine,
  readTraceLine,
  scanEvalLines,
  scanTraceLines,
  summarizeEval,
  traceFileMeta,
  EVAL_ADAPTER_VERSION,
  MAX_INVALID_SAMPLES,
  MAX_SKIP_SAMPLES,
  TRACE_ADAPTER_VERSION,
} from "@/shared/vlm/adapters/trace";

export type {
  AdapterDiagnostics,
  AdapterSkip,
} from "@/shared/vlm/adapters/types";

export type {
  EvalLineProblem,
  EvalMetricRow,
  ParsedEval,
  ParsedEvalFile,
  ParsedTraceRow,
  ParsedTurn,
  TraceFileMeta,
} from "@/shared/vlm/adapters/trace";
