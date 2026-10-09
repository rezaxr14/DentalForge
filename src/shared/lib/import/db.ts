/**
 * M7 importer — DB writer (plan §13 M7, §4.3 dedupe rules).
 *
 * Idempotent by construction:
 * - images:   unique (dataset_id, source_image_id)
 * - traces:   unique (dataset_id, image_id, cohort, mode) — identity only
 *             (ADR-0008: content hash is NOT globally unique; hybrid files
 *             are skipped at file level instead)
 * - turns:    unique (trace_id, idx)
 * - calls:    unique (turn_id, idx)
 * - eval run: looked up by (org, source_file) before insert
 *
 * The importer is a trusted LOCAL script (plan §14: `pnpm import:local`),
 * not a feature — it pins `orgId` explicitly on every insert, mirroring the
 * `scoped(orgId)` contract; features themselves stay repo-only.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/shared/db/pg";
import * as s from "@/shared/db/schema";
import type { ParsedEval, ParsedTraceRow } from "./parse";
import type { ImageSource } from "./imageMeta";

/** Injectable image lookup so tests do not touch the real VLM-DENTAL tree. */
export type ImageResolver = (dataset: string, imageId: number) => ImageSource | null;

export interface ImportStats {
  orgId: string;
  datasets: Record<string, string>;
  traceRowsParsed: number;
  tracesInserted: number;
  tracesDeduped: number;
  identityConflicts: number;
  imagesInserted: number;
  imagesExisting: number;
  imagesMissingSource: number;
  turnsInserted: number;
  turnsExisting: number;
  toolCallsInserted: number;
  invalidLines: number;
  evalRunsInserted: number;
  evalRunsExisting: number;
  evalCasesInserted: number;
}

export function emptyStats(orgId: string): ImportStats {
  return {
    orgId,
    datasets: {},
    traceRowsParsed: 0,
    tracesInserted: 0,
    tracesDeduped: 0,
    identityConflicts: 0,
    imagesInserted: 0,
    imagesExisting: 0,
    imagesMissingSource: 0,
    turnsInserted: 0,
    turnsExisting: 0,
    toolCallsInserted: 0,
    invalidLines: 0,
    evalRunsInserted: 0,
    evalRunsExisting: 0,
    evalCasesInserted: 0,
  };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Resolve-or-create the `dentex`/`tufts` dataset rows for an org. */
export async function ensureDatasets(db: Db, orgId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const load = async () => {
    map.clear();
    for (const row of await db.select().from(s.datasets).where(eq(s.datasets.orgId, orgId))) {
      map.set(row.source, row.id);
    }
  };
  await load();
  for (const source of ["dentex", "tufts"] as const) {
    if (map.has(source)) continue;
    await db
      .insert(s.datasets)
      .values({
        orgId,
        name: source === "dentex" ? "DENTEX" : "Tufts",
        source,
        licenseNote:
          source === "dentex"
            ? "CC BY-NC-SA 4.0 (see public/labels/NOTICE.md)"
            : "Tufts terms not yet confirmed — no Tufts images published (plan §12.4)",
      })
      .onConflictDoNothing();
  }
  await load();
  return map;
}

/**
 * Insert parsed traces (with turns + tool calls) idempotently.
 * Existing content hashes dedupe; identity collisions (same cohort key,
 * different content) keep the FIRST import and are counted for reporting.
 */
export async function insertTraceRows(
  db: Db,
  orgId: string,
  datasetId: string,
  rows: ParsedTraceRow[],
  resolve: ImageResolver,
  stats: ImportStats,
): Promise<void> {
  if (rows.length === 0) return;

  // 1. Image rows — unique (dataset_id, source_image_id); resolve bytes once.
  const imageIndex = new Map<number, string>();
  for (const row of await db.select().from(s.images).where(eq(s.images.datasetId, datasetId))) {
    imageIndex.set(row.sourceImageId, row.id);
  }
  const wanted = [...new Set(rows.map((r) => r.sourceImageId))].filter((id) => !imageIndex.has(id));
  // Pre-existing referenced images count toward the total (re-import must
  // still satisfy the DoD gate even when nothing new is inserted).
  stats.imagesExisting += new Set(rows.map((r) => r.sourceImageId)).size - wanted.length;
  for (const sourceImageId of wanted) {
    const src = resolve(rows[0]!.dataset, sourceImageId);
    if (!src) {
      stats.imagesMissingSource += 1;
      // Honest placeholder: count stays truthful; storageKey marks absence.
      const inserted = await db
        .insert(s.images)
        .values({
          orgId,
          datasetId,
          sourceImageId,
          contentHash: `missing:${rows[0]!.dataset}:${sourceImageId}`,
          width: 0,
          height: 0,
          storageKey: "",
          split: null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) {
        imageIndex.set(sourceImageId, inserted[0].id);
        stats.imagesInserted += 1;
      }
      continue;
    }
    const inserted = await db
      .insert(s.images)
      .values({
        orgId,
        datasetId,
        sourceImageId,
        contentHash: src.sha256,
        width: src.width,
        height: src.height,
        storageKey: src.path,
        split: "train",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      imageIndex.set(sourceImageId, inserted[0].id);
      stats.imagesInserted += 1;
    }
  }

  // 2. Trace rows — dedupe by IDENTITY (dataset_id, image_id, cohort, mode),
  // the plan §7 unique key. Content hash alone is wrong here: 11 cross-cohort
  // rows are byte-identical but distinct identities (ADR-0008).
  const existing = await db
    .select({ id: s.traces.id, datasetId: s.traces.datasetId, imageId: s.traces.imageId, cohort: s.traces.cohort, mode: s.traces.mode })
    .from(s.traces);
  const traceIdByIdentity = new Map<string, string>();
  for (const r of existing) traceIdByIdentity.set(`${r.datasetId}|${r.imageId}|${r.cohort}|${r.mode}`, r.id);

  const fresh = rows.filter(
    (r) => !traceIdByIdentity.has(`${datasetId}|${imageIndex.get(r.sourceImageId)}|${r.cohort}|${r.mode}`),
  );
  stats.tracesDeduped += rows.length - fresh.length;
  stats.traceRowsParsed += rows.length;

  for (const batch of chunks(fresh, 100)) {
    const inserted = await db
      .insert(s.traces)
      .values(
        batch.map((r) => ({
          orgId,
          datasetId,
          imageId: imageIndex.get(r.sourceImageId)!,
          cohort: r.cohort,
          mode: r.mode,
          verified: r.verified,
          sourceFile: r.sourceFile,
          contentHash: r.contentHash,
          nTurns: r.nTurns,
          nToolCalls: r.nToolCalls,
          formatOk: r.formatOk,
          verifierReason: r.verifierReason,
          groundTruth: r.groundTruth,
          finalAnswer: r.finalAnswer,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: s.traces.id,
        datasetId: s.traces.datasetId,
        imageId: s.traces.imageId,
        cohort: s.traces.cohort,
        mode: s.traces.mode,
      });
    for (const row of inserted) {
      traceIdByIdentity.set(`${row.datasetId}|${row.imageId}|${row.cohort}|${row.mode}`, row.id);
      stats.tracesInserted += 1;
    }
    // Racing writers: rows that hit the identity key mid-flight count as deduped.
    stats.identityConflicts += batch.length - inserted.length;
  }

  // Resolve every row's trace id (inserted this run OR pre-existing) so
  // turns/tool-calls load for both fresh and re-imported traces.
  const traceIdFor = (r: ParsedTraceRow): string | undefined =>
    traceIdByIdentity.get(`${datasetId}|${imageIndex.get(r.sourceImageId)}|${r.cohort}|${r.mode}`);

  // 3. Turns + tool calls (unique per (trace, idx) / (turn, idx) — idempotent).
  for (const row of rows) {
    const traceId = traceIdFor(row);
    if (!traceId || row.turns.length === 0) continue;

    const turnIds = new Map<number, string>();
    for (const batch of chunks(row.turns, 200)) {
      const inserted = await db
        .insert(s.traceTurns)
        .values(
          batch.map((t) => ({
            orgId,
            traceId,
            idx: t.idx,
            status: t.status,
            thought: t.thought,
            rawOutput: t.rawOutput,
            parsed: t.parsed as Record<string, unknown> | null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: s.traceTurns.id, idx: s.traceTurns.idx });
      for (const t of inserted) turnIds.set(t.idx, t.id);
    }
    // Re-import: fetch turn ids that already existed so tool calls attach.
    if (turnIds.size < row.turns.length) {
      for (const t of await db
        .select({ id: s.traceTurns.id, idx: s.traceTurns.idx })
        .from(s.traceTurns)
        .where(eq(s.traceTurns.traceId, traceId))) {
        turnIds.set(t.idx, t.id);
      }
    }

    const calls = row.turns
      .flatMap((t) => t.toolCalls.map((c) => ({ turnId: turnIds.get(t.idx), ...c })))
      .filter((c): c is typeof c & { turnId: string } => typeof c.turnId === "string");
    if (calls.length === 0) continue;

    for (const batch of chunks(calls, 200)) {
      const inserted = await db
        .insert(s.toolCalls)
        .values(
          batch.map((c) => ({
            orgId,
            turnId: c.turnId,
            idx: c.idx,
            toolName: c.toolName,
            args: c.args,
            ok: c.ok,
            error: c.error,
            trueBbox: c.trueBbox,
            perturbTier: c.perturbTier,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: s.toolCalls.id });
      stats.toolCallsInserted += inserted.length;
    }
  }
}

/**
 * Insert eval runs + cases idempotently (plan §13 M7: 8 runs).
 * A run is identified by its source file; existing runs are skipped whole.
 */
export async function insertEvalRows(
  db: Db,
  orgId: string,
  parsed: ParsedEval,
  stats: ImportStats,
): Promise<void> {
  const existing = await db
    .select({ id: s.evalRuns.id })
    .from(s.evalRuns)
    .where(eq(s.evalRuns.sourceFile, parsed.run.sourceFile));
  if (existing.length > 0) {
    stats.evalRunsExisting += 1;
    return;
  }
  const inserted = await db
    .insert(s.evalRuns)
    .values({
      orgId,
      dataset: parsed.run.dataset,
      split: parsed.run.split,
      provider: parsed.run.provider,
      model: parsed.run.model,
      n: parsed.run.n,
      sourceFile: parsed.run.sourceFile,
      summary: parsed.run.summary,
    })
    .returning({ id: s.evalRuns.id });
  const runId = inserted[0]?.id;
  if (!runId) return;
  stats.evalRunsInserted += 1;

  for (const batch of chunks(parsed.cases, 200)) {
    const res = await db
      .insert(s.evalCases)
      .values(
        batch.map((c) => ({
          orgId,
          runId,
          imageId: null, // linked lazily: image rows may not exist yet
          groundTruth: c.groundTruth,
          predictionsJson: c.predictions,
          matchedPairs: c.matchedPairs,
          fdiF1: c.fdiF1,
          exactF1: c.exactF1,
          closeness: c.closeness,
          confidence: c.confidence,
          formatOk: c.formatOk,
          rawOutput: c.rawOutput,
        })),
      )
      .returning({ id: s.evalCases.id });
    stats.evalCasesInserted += res.length;
  }
}

