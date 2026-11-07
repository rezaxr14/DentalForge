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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  /** Trace-level facts that are not part of the VerifiedTrace file contract. */
  mode: "with_tools" | "no_tools";
  cohort: string;
  verified: boolean;
  /** Radiograph backing the trace, when the source can resolve one. */
  image: TraceImage | null;
}

export interface TraceImage {
  storageKey: string;
  width: number;
  height: number;
  dataset: string;
  sourceImageId: number;
}

export interface EvalCaseDetail {
  id: string;
  evalCase: EvalCaseT;
  provenance: DataProvenance;
}

/** One eval run with its cases — the leaderboard's drill-down. */
export interface EvalRunDetail {
  id: string;
  model: string;
  provider: string;
  dataset: string;
  split: string;
  n: number;
  summary: Record<string, number>;
  cases: EvalCaseT[];
  provenance: DataProvenance;
}

/** A stored image artifact reachable through the storage gateway (plan §7 artifacts). */
export interface ArtifactImageRef {
  id: string;
  storageKey: string;
  provenance: "worker_exact" | "browser_approx" | "import_replay";
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
  getEvalRun(id: string): Promise<EvalRunDetail | null>;
  getEvalCase(id: string): Promise<EvalCaseDetail | null>;
  /** Stored image artifacts for trace tool calls (fixture source: none exist yet). */
  getArtifactImages(ids: string[]): Promise<ArtifactImageRef[]>;
}

/** Committed sanitized fixtures — always available, no DB needed. */
export function fixtureSource(): DataSource {
  // Public pages are DENTEX-only. The committed fixtures still include one
  // Tufts trace for the cross-dataset ingestion tests, but it must never reach
  // a rendered page (plan §7: Tufts data is never public).
  const publicTraces = () => listFixtureTraces().filter((t) => t.dataset.toLowerCase() === "dentex");
  return {
    provenance: "fixture",
    listTraces: () =>
      Promise.resolve(
        publicTraces().map((t) => ({ ...t, provenance: "fixture" as const })),
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
      const t = parsed.data;
      if (t.dataset.toLowerCase() !== "dentex") return Promise.resolve(null);
      const summary = listFixtureTraces().find((r) => r.id === id);
      // The committed fixtures ship five DENTEX derivatives under public/labels.
      const label = t.image_id >= 1 && t.image_id <= 5 ? t.image_id : null;
      return Promise.resolve({
        id,
        trace: t,
        provenance: "fixture" as const,
        mode: summary?.mode ?? (t.tool_calls ? "with_tools" : "no_tools"),
        cohort: summary?.cohort ?? "fixture",
        verified: summary?.verified ?? true,
        image: label
          ? {
              storageKey: `labels/${label}.jpg`,
              width: 1600,
              height: 767,
              dataset: t.dataset,
              sourceImageId: t.image_id,
            }
          : null,
      });
    },
    listEvalRuns: () =>
      Promise.resolve(
        listFixtureEvals().map((r) => ({ ...r, provenance: "fixture" as const })),
      ),
    getEvalRun: (id) => {
      const row = listFixtureEvals().find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      let raw: unknown;
      try {
        raw = getFixtureEval(id);
      } catch {
        return Promise.resolve(null);
      }
      const parsed = EvalCase.safeParse(raw);
      if (!parsed.success) return Promise.resolve(null);
      return Promise.resolve({
        id,
        model: row.model,
        provider: row.provider,
        dataset: row.dataset,
        split: parsed.data.split,
        n: row.n,
        summary: { exact_f1: row.exactF1, fdi_f1: row.fdiF1 },
        cases: [parsed.data],
        provenance: "fixture" as const,
      });
    },
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
    // The committed fixtures ship no artifact rows (the case-study renders live
    // in VLM-DENTAL; see FEATURES["trace.render_artifacts"]).
    getArtifactImages: () => Promise.resolve([]),
  };
}

/** Imported rows for one org — org-scoped on every query (plan section 5.2). */
export function postgresSource(db: Db, orgId: string): DataSource {
  return {
    provenance: "postgres",
    listTraces: () => listTraceRows(db, orgId),
    getTraceDetail: (id) => getTraceRow(db, orgId, id),
    listEvalRuns: () => listEvalRunRows(db, orgId),
    getEvalRun: (id) => getEvalRunRow(db, orgId, id),
    getEvalCase: (id) => getEvalCaseRow(db, orgId, id),
    getArtifactImages: (ids) => getArtifactImageRows(db, orgId, ids),
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
      groundTruth: s.traces.groundTruth,
      datasetSource: s.datasets.source,
      sourceImageId: s.images.sourceImageId,
      imageStorageKey: s.images.storageKey,
      imageWidth: s.images.width,
      imageHeight: s.images.height,
    })
    .from(s.traces)
    .innerJoin(s.images, eq(s.traces.imageId, s.images.id))
    .innerJoin(s.datasets, eq(s.traces.datasetId, s.datasets.id))
    .where(eq(s.traces.orgId, orgId))
    .orderBy(asc(s.traces.createdAt));
  return rows.map((r) => {
    const finalAnswer = Array.isArray(r.finalAnswer) ? r.finalAnswer : [];
    const conditions = new Set<string>();
    for (const list of [r.groundTruth, r.finalAnswer]) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (f && typeof f === "object" && "diagnosis" in f) {
          const d = (f as { diagnosis?: unknown }).diagnosis;
          if (typeof d === "string" && d.length > 0) conditions.add(d);
        }
      }
    }
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
      imageKey: r.imageStorageKey,
      imageWidth: r.imageWidth,
      imageHeight: r.imageHeight,
      conditions: [...conditions],
    };
  });
}

/** A path id is only meaningful if it is a UUID; otherwise the DB would throw. */
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function getTraceRow(
  db: Db,
  orgId: string,
  id: string,
): Promise<TraceDetail | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select({
      id: s.traces.id,
      verified: s.traces.verified,
      mode: s.traces.mode,
      cohort: s.traces.cohort,
      formatOk: s.traces.formatOk,
      verifierReason: s.traces.verifierReason,
      groundTruth: s.traces.groundTruth,
      finalAnswer: s.traces.finalAnswer,
      datasetSource: s.datasets.source,
      sourceImageId: s.images.sourceImageId,
      imageWidth: s.images.width,
      imageHeight: s.images.height,
      imageStorageKey: s.images.storageKey,
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
        // Kept by ToolCallRecord's passthrough; lets the trace viewer follow
        // the §9 ladder from a stored artifact to a placeholder.
        ...(c.artifactId ? { artifact_id: c.artifactId } : {}),
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
  return {
    id,
    trace: parsed.data,
    provenance: "postgres" as const,
    mode: t.mode,
    cohort: t.cohort,
    verified: t.verified ?? false,
    image: t.imageStorageKey
      ? {
          storageKey: t.imageStorageKey,
          width: t.imageWidth ?? 0,
          height: t.imageHeight ?? 0,
          dataset: t.datasetSource,
          sourceImageId: t.sourceImageId,
        }
      : null,
  };
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

/** Org-scoped lookup of stored image artifacts (cross-tenant ids simply miss). */
async function getArtifactImageRows(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<ArtifactImageRef[]> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return [];
  const rows = await db
    .select({
      id: s.artifacts.id,
      storageKey: s.artifacts.storageKey,
      provenance: s.artifacts.provenance,
      kind: s.artifacts.kind,
    })
    .from(s.artifacts)
    .where(and(eq(s.artifacts.orgId, orgId), inArray(s.artifacts.id, unique)));
  return rows
    .filter((r) => r.kind === "tool_image" || r.kind === "agent_image")
    .map((r) => ({ id: r.id, storageKey: r.storageKey, provenance: r.provenance }));
}

type EvalCaseRow = typeof s.evalCases.$inferSelect;

function evalCaseRaw(
  c: EvalCaseRow,
  run: { dataset: string; split: string; provider: string; model: string },
): unknown {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    image_id: c.sourceImageId ?? 0,
    dataset: run.dataset,
    split: run.split,
    provider: run.provider,
    model: run.model,
    ground_truth: arr(c.groundTruth),
    predictions: arr(c.predictionsJson),
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
}

async function getEvalRunRow(
  db: Db,
  orgId: string,
  id: string,
): Promise<EvalRunDetail | null> {
  if (!isUuid(id)) return null;
  const runRows = await db
    .select()
    .from(s.evalRuns)
    .where(and(eq(s.evalRuns.orgId, orgId), eq(s.evalRuns.id, id)))
    .limit(1);
  const run = runRows[0];
  if (!run) return null;
  const caseRows = await db
    .select()
    .from(s.evalCases)
    .where(and(eq(s.evalCases.orgId, orgId), eq(s.evalCases.runId, id)))
    .orderBy(asc(s.evalCases.sourceImageId));
  const cases: EvalCaseT[] = [];
  for (const c of caseRows) {
    const parsed = EvalCase.safeParse(evalCaseRaw(c, run));
    if (parsed.success) cases.push(parsed.data);
  }
  return {
    id,
    model: run.model,
    provider: run.provider,
    dataset: run.dataset,
    split: run.split,
    n: run.n ?? cases.length,
    summary: (run.summary ?? {}) as Record<string, number>,
    cases,
    provenance: "postgres" as const,
  };
}

async function getEvalCaseRow(
  db: Db,
  orgId: string,
  id: string,
): Promise<EvalCaseDetail | null> {
  if (!isUuid(id)) return null;
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
  const parsed = EvalCase.safeParse(
    evalCaseRaw(c as unknown as EvalCaseRow, {
      dataset: c.runDataset,
      split: c.runSplit,
      provider: c.runProvider,
      model: c.runModel,
    }),
  );
  if (!parsed.success) return null;
  return { id, evalCase: parsed.data, provenance: "postgres" as const };
}
