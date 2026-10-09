/**
 * DataSource (plan section 11, M7) — interchangeable read layer behind the
 * Trace Explorer and Eval Hub pages.
 *
 * - Offline/demo (no Postgres): `fixtureSource` reads the committed sanitized
 *   fixtures — the app always boots and renders (plan section 9).
 * - Prod (imported Postgres): `postgresSource(db, orgId)` reads the rows
 *   written by `pnpm import:local|hf` through org-scoped Drizzle queries.
 *
 * Provenance (plan section 9.2): every payload carries `provenance`
 * ("fixture" | "postgres") so the UI can badge where numbers came from.
 * Counts are always computed from the underlying data (plan rule 3).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  EvalCase,
  VerifiedTrace,
  type EvalCaseT,
  type VerifiedTraceT,
} from "@/shared/contracts/traces";
import type { Db } from "@/shared/db/pg";
import * as s from "@/shared/db/schema";
import {
  getEval as getFixtureEval,
  getTrace as getFixtureTrace,
  listEvals as listFixtureEvals,
  listTraces as listFixtureTraces,
  type EvalSummary,
  type TraceSummary,
} from "./fixtures";

export type DataProvenance = "fixture" | "postgres";

export interface TraceDetail {
  id: string;
  trace: VerifiedTraceT;
  provenance: DataProvenance;
}

export interface EvalCaseDetail {
  id: string;
  evalCase: EvalCaseT;
  provenance: DataProvenance;
}

export interface LeaderboardRow extends EvalSummary {
  provenance: DataProvenance;
}

export interface TraceListRow extends TraceSummary {
  provenance: DataProvenance;
}

export interface DataSource {
  readonly provenance: DataProvenance;
  listTraces(): Promise<TraceListRow[]>;
  getTraceDetail(id: string): Promise<TraceDetail | null>;
  listEvalRuns(): Promise<LeaderboardRow[]>;
  getEvalCase(id: string): Promise<EvalCaseDetail | null>;
}

/** Committed sanitized fixtures — always available, no DB needed. */
export function fixtureSource(): DataSource {
  return {
    provenance: "fixture",
    listTraces: () =>
      Promise.resolve(
        listFixtureTraces().map((t) => ({ ...t, provenance: "fixture" as const })),
      ),
    getTraceDetail: (id) => {
      let raw: unknown;
      try {
        raw = getFixtureTrace(id);
      } catch {
        return Promise.resolve(null);
      }
      const parsed = VerifiedTrace.safeParse(raw);
      if (!parsed.success) return Promise.resolve(null);
      return Promise.resolve({ id, trace: parsed.data, provenance: "fixture" as const });
    },
    listEvalRuns: () =>
      Promise.resolve(
        listFixtureEvals().map((r) => ({ ...r, provenance: "fixture" as const })),
      ),
    getEvalCase: (id) => {
      let raw: unknown;
      try {
        raw = getFixtureEval(id);
      } catch {
        return Promise.resolve(null);
      }
      const parsed = EvalCase.safeParse(raw);
      if (!parsed.success) return Promise.resolve(null);
      return Promise.resolve({ id, evalCase: parsed.data, provenance: "fixture" as const });
    },
  };
}

/** Imported rows for one org — org-scoped on every query (plan section 5.2). */
export function postgresSource(db: Db, orgId: string): DataSource {
  return {
    provenance: "postgres",
    listTraces: () => listTraceRows(db, orgId),
    getTraceDetail: (id) => getTraceRow(db, orgId, id),
    listEvalRuns: () => listEvalRunRows(db, orgId),
    getEvalCase: (id) => getEvalCaseRow(db, orgId, id),
  };
}

async function listTraceRows(db: Db, orgId: string): Promise<TraceListRow[]> {
  const rows = await db
    .select({
      id: s.traces.id,
      cohort: s.traces.cohort,
      mode: s.traces.mode,
      verified: s.traces.verified,
      sourceFile: s.traces.sourceFile,
      nTurns: s.traces.nTurns,
      nToolCalls: s.traces.nToolCalls,
      formatOk: s.traces.formatOk,
      finalAnswer: s.traces.finalAnswer,
      datasetSource: s.datasets.source,
      sourceImageId: s.images.sourceImageId,
    })
    .from(s.traces)
    .innerJoin(s.images, eq(s.traces.imageId, s.images.id))
    .innerJoin(s.datasets, eq(s.traces.datasetId, s.datasets.id))
    .where(eq(s.traces.orgId, orgId))
    .orderBy(asc(s.traces.createdAt));
  return rows.map((r) => {
    const finalAnswer = Array.isArray(r.finalAnswer) ? r.finalAnswer : [];
    return {
      id: r.id,
      file: r.sourceFile ?? "",
      dataset: r.datasetSource,
      imageId: r.sourceImageId,
      mode: r.mode,
      cohort: r.cohort,
      nTurns: r.nTurns,
      nToolCalls: r.nToolCalls,
      formatOk: r.formatOk ?? false,
      nFindings: finalAnswer.length,
      verified: r.verified ?? false,
      provenance: "postgres" as const,
    };
  });
}

async function getTraceRow(
  db: Db,
  orgId: string,
  id: string,
): Promise<TraceDetail | null> {
  const rows = await db
    .select({
      id: s.traces.id,
      verified: s.traces.verified,
      formatOk: s.traces.formatOk,
      verifierReason: s.traces.verifierReason,
      groundTruth: s.traces.groundTruth,
      finalAnswer: s.traces.finalAnswer,
      datasetSource: s.datasets.source,
      sourceImageId: s.images.sourceImageId,
    })
    .from(s.traces)
    .innerJoin(s.images, eq(s.traces.imageId, s.images.id))
    .innerJoin(s.datasets, eq(s.traces.datasetId, s.datasets.id))
    .where(and(eq(s.traces.orgId, orgId), eq(s.traces.id, id)))
    .limit(1);
  const t = rows[0];
  if (!t) return null;

  const turnRows = await db
    .select()
    .from(s.traceTurns)
    .where(and(eq(s.traceTurns.orgId, orgId), eq(s.traceTurns.traceId, t.id)))
    .orderBy(asc(s.traceTurns.idx));
  const turnIds = turnRows.map((r) => r.id);
  const callRows =
    turnIds.length > 0
      ? await db
          .select()
          .from(s.toolCalls)
          .where(
            and(
              eq(s.toolCalls.orgId, orgId),
              sql`${s.toolCalls.turnId} in (${sql.join(
                turnIds.map((v) => sql`${v}::uuid`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(asc(s.toolCalls.idx))
      : [];
  const callsByTurn = new Map<string, typeof callRows>();
  for (const c of callRows) {
    const list = callsByTurn.get(c.turnId) ?? [];
    list.push(c);
    callsByTurn.set(c.turnId, list);
  }

  const raw = {
    image_id: t.sourceImageId,
    image_path: "",
    dataset: t.datasetSource,
    ground_truth: (t.groundTruth ?? []) as unknown[],
    turns: turnRows.map((turn) => ({
      turn: turn.idx,
      raw_output: turn.rawOutput ?? undefined,
      parsed: (turn.parsed ?? null) as Record<string, unknown> | null,
      status: turn.status,
      tool_calls_this_turn: (callsByTurn.get(turn.id) ?? []).map((c) => ({
        tool_name: c.toolName,
        tool_args: (c.args ?? {}) as Record<string, unknown>,
        tool_ok: c.ok ?? false,
      })),
    })),
    tool_calls: turnRows.reduce((n, turn) => n + (callsByTurn.get(turn.id) ?? []).length, 0),
    final_answer: t.finalAnswer ?? null,
    messages: [],
    format_ok: t.formatOk ?? false,
    ...(t.verifierReason ? { verifier_reason: t.verifierReason } : {}),
  };
  const parsed = VerifiedTrace.safeParse(raw);
  if (!parsed.success) return null;
  return { id, trace: parsed.data, provenance: "postgres" as const };
}

async function listEvalRunRows(db: Db, orgId: string): Promise<LeaderboardRow[]> {
  const rows = await db
    .select()
    .from(s.evalRuns)
    .where(eq(s.evalRuns.orgId, orgId))
    .orderBy(asc(s.evalRuns.createdAt));
  return rows.map((r) => {
    const summary = (r.summary ?? {}) as Record<string, number>;
    return {
      id: r.id,
      file: r.sourceFile ?? "",
      model: r.model,
      provider: r.provider,
      dataset: r.dataset,
      n: r.n ?? 0,
      exactF1: summary.exact_f1 ?? 0,
      fdiF1: summary.fdi_f1 ?? 0,
      provenance: "postgres" as const,
    };
  });
}

async function getEvalCaseRow(
  db: Db,
  orgId: string,
  id: string,
): Promise<EvalCaseDetail | null> {
  const rows = await db
    .select({
      id: s.evalCases.id,
      groundTruth: s.evalCases.groundTruth,
      predictions: s.evalCases.predictionsJson,
      matchedPairs: s.evalCases.matchedPairs,
      fdiF1: s.evalCases.fdiF1,
      exactF1: s.evalCases.exactF1,
      closeness: s.evalCases.closeness,
      confidence: s.evalCases.confidence,
      formatOk: s.evalCases.formatOk,
      rawOutput: s.evalCases.rawOutput,
      runDataset: s.evalRuns.dataset,
      runSplit: s.evalRuns.split,
      runProvider: s.evalRuns.provider,
      runModel: s.evalRuns.model,
    })
    .from(s.evalCases)
    .innerJoin(s.evalRuns, eq(s.evalCases.runId, s.evalRuns.id))
    .where(and(eq(s.evalCases.orgId, orgId), eq(s.evalCases.id, id)))
    .limit(1);
  const c = rows[0];
  if (!c) return null;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const raw = {
    image_id: 0,
    dataset: c.runDataset,
    split: c.runSplit,
    provider: c.runProvider,
    model: c.runModel,
    ground_truth: arr(c.groundTruth),
    predictions: arr(c.predictions),
    matched_pairs: arr(c.matchedPairs),
    fdi_precision: 0,
    fdi_recall: 0,
    fdi_f1: c.fdiF1 ?? 0,
    exact_precision: 0,
    exact_recall: 0,
    exact_f1: c.exactF1 ?? 0,
    closeness_score: c.closeness ?? 0,
    spatial_proximity: 0,
    diagnostic_similarity: 0,
    fdi_correct: false,
    quadrant_correct: false,
    tooth_position_correct: false,
    diagnosis_correct: false,
    exact_match: false,
    all_exact_match: false,
    raw_output: c.rawOutput ?? "",
    format_ok: c.formatOk ?? false,
    finish_reason: "",
    ...(c.confidence != null ? { confidence: c.confidence } : {}),
  };
  const parsed = EvalCase.safeParse(raw);
  if (!parsed.success) return null;
  return { id, evalCase: parsed.data, provenance: "postgres" as const };
}
