/**
 * Turning a worker-supplied trace into the repo's insert shape (plan §10.1 `ingest/traces`, ADR-0012).
 *
 * Deliberately REUSES the M7 importer's `parseTraceLine`, so a trace that arrives over HTTP is
 * interpreted exactly like the same trace read from a JSONL file (turn status, thought extraction,
 * tool-call counting, ...). Only the identity/hash step differs: there is no raw line over HTTP, so the
 * content hash is taken over a CANONICAL line (sorted keys, no `messages`, no `image_path`).
 */
import type { IngestTraceT } from "@/shared/contracts/ingest";
import type { IngestTraceInput } from "@/shared/db/repos";
import { parseTraceLine } from "@/shared/lib/import/parse";

/** Deterministic JSON: object keys sorted recursively, `undefined` dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The line whose hash identifies a trace's CONTENT: transcript and machine path replaced by constants. */
export function canonicalTraceLine(item: IngestTraceT): string {
  const { messages: _m, image_path: _p, ...rest } = item;
  void _m;
  void _p;
  return canonicalJson({ ...rest, image_path: "", messages: [] });
}

export type TraceBatchSourceT = {
  cohort: string;
  mode: "with_tools" | "no_tools";
  verified: boolean;
  sourceFile?: string | undefined;
};

/** `null` only if the importer's own parser rejects the trace (the request schema should already have caught it). */
export function prepareTrace(item: IngestTraceT, source: TraceBatchSourceT, datasetId: string): IngestTraceInput | null {
  const row = parseTraceLine(canonicalTraceLine(item), source.sourceFile ?? "api:ingest", {
    cohort: source.cohort,
    mode: source.mode,
    verified: source.verified,
    priority: 0,
  });
  if (!row) return null;
  // Turn numbers are the storage key (unique per trace). A repeat would abort the whole item at the database,
  // so it is reported as an invalid trace instead.
  if (new Set(row.turns.map((t) => t.idx)).size !== row.turns.length) return null;
  return {
    datasetId,
    sourceImageId: row.sourceImageId,
    cohort: row.cohort,
    mode: row.mode,
    verified: row.verified,
    sourceFile: source.sourceFile ?? null,
    contentHash: row.contentHash,
    nTurns: row.nTurns,
    nToolCalls: row.nToolCalls,
    formatOk: row.formatOk,
    verifierReason: row.verifierReason,
    groundTruth: row.groundTruth,
    finalAnswer: row.finalAnswer,
    turns: row.turns,
  };
}
