/**
 * `pnpm demo:seed` — idempotent seed of the DENTEX-only public demo bundle.
 *
 * Reads `demo/bundle.json` (built by `scripts/demo_build.py`) and writes the
 * Demo org through the same import writers `pnpm import:local` uses. Never
 * touches Tufts: the bundle builder already refuses it, and this script
 * asserts every dataset is `dentex` before writing.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { getPgDb, getPool } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import * as s from "@/shared/db/schema";
import {
  emptyStats,
  ensureDatasets,
  insertEvalRows,
  insertTraceRows,
  type ImageResolver,
} from "@/shared/lib/import/db";
import {
  contentHashOf,
  summarizeEval,
  traceFileMeta,
  type ParsedEval,
  type ParsedTraceRow,
} from "@/shared/lib/import/parse";
import type { ImageSource } from "@/shared/lib/import/imageMeta";

type BundleImage = {
  key: string;
  datasetId: number;
  sourceFile: string;
  split: string;
  full: string;
  thumb: string;
  width: number;
  height: number;
  sha256: string;
  license: string;
};

type BundleTrace = {
  image_id: number;
  dataset: string;
  ground_truth: unknown[];
  turns: {
    turn: number;
    status?: string;
    raw_output?: string;
    parsed?: unknown;
    tool_calls_this_turn?: {
      tool_name: string;
      tool_args: Record<string, unknown>;
      tool_ok: boolean;
      tool_error?: string;
      true_bbox?: unknown;
      perturb_tier?: string;
      artifact_key?: string;
    }[];
  }[];
  tool_calls: number | unknown[];
  final_answer: unknown;
  format_ok: boolean;
  verifier_reason?: string | null;
  source_file: string;
};

type BundleEvalCase = {
  image_id: number;
  ground_truth: unknown;
  predictions: unknown;
  matched_pairs: unknown;
  fdi_f1: number;
  exact_f1: number;
  closeness_score: number;
  spatial_proximity: number;
  diagnostic_similarity: number;
  confidence: number | null;
  format_ok: boolean;
  raw_output: string;
};

type BundleEval = {
  runKey: string;
  sourceFile: string;
  dataset: string;
  split: string;
  provider: string;
  model: string;
  n: number;
  cases: BundleEvalCase[];
};

type Bundle = {
  version: number;
  images: BundleImage[];
  traces: BundleTrace[];
  evals: BundleEval[];
  models: { name: string; stage: string; backend: string; notes: string; metrics: Record<string, unknown>; license: string }[];
};

const ROOT = resolve(process.cwd());
const BUNDLE_PATH = join(ROOT, "demo", "bundle.json");
const DEMO_SLUG = process.env.DEMO_ORG_SLUG ?? "demo";
const DRY_RUN = process.argv.includes("--dry-run");
const RESET = process.argv.includes("--reset");

function fail(msg: string): never {
  console.error(`[demo:seed] ${msg}`);
  process.exit(1);
}

function imageResolver(images: BundleImage[]): ImageResolver {
  const byId = new Map<number, ImageSource>();
  for (const im of images) {
    if (im.split !== "train") continue;
    byId.set(im.datasetId, {
      path: im.full,
      storageKey: im.full,
      width: im.width,
      height: im.height,
      bytes: 0,
      sha256: im.sha256,
    });
  }
  return (dataset, imageId) => (dataset === "dentex" ? byId.get(imageId) ?? null : null);
}

function toParsedTrace(t: BundleTrace): ParsedTraceRow {
  const meta = traceFileMeta(t.source_file);
  return {
    dataset: t.dataset,
    sourceImageId: t.image_id,
    cohort: meta.cohort,
    mode: meta.mode,
    verified: true,
    sourceFile: t.source_file,
    contentHash: contentHashOf(JSON.stringify(t)),
    nTurns: t.turns.length,
    nToolCalls:
      meta.mode === "no_tools"
        ? 0
        : t.turns.reduce((n, turn) => n + (turn.tool_calls_this_turn?.length ?? 0), 0) ||
          (typeof t.tool_calls === "number" ? t.tool_calls : 0),
    formatOk: t.format_ok,
    verifierReason: t.verifier_reason ?? null,
    groundTruth: t.ground_truth,
    finalAnswer: t.final_answer,
    turns: t.turns.map((turn) => ({
      idx: turn.turn,
      status: turn.status ?? "",
      thought:
        typeof (turn.parsed as { thought?: unknown } | undefined)?.thought === "string"
          ? ((turn.parsed as { thought: string }).thought)
          : null,
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
    })),
    adapterVersion: "trace.v1",
    extra: {},
  };
}

function toParsedEval(run: BundleEval): ParsedEval {
  const cases = run.cases.map((c) => ({
    sourceImageId: c.image_id,
    groundTruth: c.ground_truth,
    predictions: c.predictions,
    matchedPairs: c.matched_pairs,
    fdiF1: c.fdi_f1,
    exactF1: c.exact_f1,
    closeness: c.closeness_score,
    spatial: c.spatial_proximity,
    diagSim: c.diagnostic_similarity,
    confidence: c.confidence,
    formatOk: c.format_ok,
    rawOutput: c.raw_output,
  }));
  return {
    run: {
      dataset: run.dataset,
      split: run.split,
      provider: run.provider,
      model: run.model,
      n: cases.length,
      sourceFile: run.sourceFile,
      summary: summarizeEval(cases),
      adapterVersion: "eval.v1",
    },
    cases,
  };
}

async function main(): Promise<void> {
  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8")) as Bundle;
  if (bundle.version !== 1) fail(`unsupported bundle version ${bundle.version}`);

  for (const im of bundle.images) {
    if (!im.full.startsWith("demo-assets/")) fail(`image ${im.key} is not a demo asset: ${im.full}`);
  }
  for (const t of bundle.traces) {
    if (t.dataset !== "dentex") fail(`trace ${t.image_id} is ${t.dataset}; only dentex is public`);
  }
  for (const e of bundle.evals) {
    if (e.dataset !== "dentex") fail(`eval ${e.sourceFile} is ${e.dataset}; only dentex is public`);
  }
  const tufts = JSON.stringify(bundle).toLowerCase().includes("tufts");
  if (tufts) fail("bundle mentions Tufts; refusing to seed");

  console.log(
    `[demo:seed] bundle: ${bundle.images.length} images, ${bundle.traces.length} traces, ` +
      `${bundle.evals.length} eval runs, ${bundle.models.length} models`,
  );
  if (DRY_RUN) {
    console.log("[demo:seed] --dry-run: no database writes");
    return;
  }

  const db = getPgDb();
  const store = new DrizzleOrgStore(db);
  let existingOrg = await store.getOrgBySlug(DEMO_SLUG);
  if (RESET && existingOrg) {
    // Deleting the org cascades to every seeded row; the bundle is the source of truth.
    await db.delete(s.organizations).where(eq(s.organizations.id, existingOrg.id));
    console.log(`[demo:seed] --reset: removed previous org ${DEMO_SLUG}`);
    existingOrg = null;
  }
  const org = existingOrg ?? (await store.createOrg({ slug: DEMO_SLUG, name: "Demo" }));
  console.log(`[demo:seed] org ${DEMO_SLUG} = ${org.id}`);

  const datasets = await ensureDatasets(db, org.id);
  const dentexId = datasets.get("dentex");
  if (!dentexId) fail("dentex dataset row missing");

  // Images first: the trace writer resolves them by (dataset, source id).
  for (const im of bundle.images) {
    if (im.split !== "train") continue;
    await db
      .insert(s.images)
      .values({
        orgId: org.id,
        datasetId: dentexId,
        sourceImageId: im.datasetId,
        contentHash: im.sha256,
        width: im.width,
        height: im.height,
        storageKey: im.full,
        split: "train",
      })
      .onConflictDoNothing();
  }

  const stats = emptyStats(org.id);
  await insertTraceRows(
    db,
    org.id,
    dentexId,
    bundle.traces.map(toParsedTrace),
    imageResolver(bundle.images),
    stats,
  );
  console.log(
    `[demo:seed] traces: ${stats.tracesInserted} inserted, ${stats.tracesDeduped} already present, ` +
      `${stats.imagesInserted} images inserted`,
  );

  // Artifacts: one row per rendered tool image, then link the tool call.
  let artifactLinks = 0;
  for (const t of bundle.traces) {
    const traceRow = await db
      .select({ id: s.traces.id })
      .from(s.traces)
      .innerJoin(s.images, eq(s.traces.imageId, s.images.id))
      .where(and(eq(s.traces.orgId, org.id), eq(s.images.sourceImageId, t.image_id)))
      .limit(1);
    const traceId = traceRow[0]?.id;
    if (!traceId) continue;
    for (const turn of t.turns) {
      const calls = turn.tool_calls_this_turn ?? [];
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i]!;
        if (!c.artifact_key) continue;
        const existing = await db
          .select({ id: s.artifacts.id })
          .from(s.artifacts)
          .where(and(eq(s.artifacts.orgId, org.id), eq(s.artifacts.storageKey, c.artifact_key)))
          .limit(1);
        let artifactId = existing[0]?.id;
        if (!artifactId) {
          const inserted = await db
            .insert(s.artifacts)
            .values({
              orgId: org.id,
              kind: "tool_image",
              provenance: "import_replay",
              storageKey: c.artifact_key,
              mime: "image/jpeg",
              bytes: statSync(join(ROOT, "public", c.artifact_key)).size,
              sha256: contentHashOf(c.artifact_key),
            })
            .returning({ id: s.artifacts.id });
          artifactId = inserted[0]?.id;
        }
        if (!artifactId) continue;
        const turnRow = await db
          .select({ id: s.traceTurns.id })
          .from(s.traceTurns)
          .where(and(eq(s.traceTurns.traceId, traceId), eq(s.traceTurns.idx, turn.turn)))
          .limit(1);
        const turnId = turnRow[0]?.id;
        if (!turnId) continue;
        await db
          .update(s.toolCalls)
          .set({ artifactId })
          .where(and(eq(s.toolCalls.turnId, turnId), eq(s.toolCalls.idx, i)));
        artifactLinks += 1;
      }
    }
  }
  console.log(`[demo:seed] artifacts linked: ${artifactLinks}`);

  for (const run of bundle.evals) {
    await insertEvalRows(db, org.id, toParsedEval(run), stats);
  }
  console.log(
    `[demo:seed] evals: ${stats.evalRunsInserted} inserted, ${stats.evalRunsExisting} already present, ` +
      `${stats.evalCasesInserted} cases inserted`,
  );

  for (const m of bundle.models) {
    const isYolo = m.backend === "ultralytics";
    await db
      .insert(s.modelRegistry)
      .values({
        orgId: org.id,
        name: m.name,
        kind: isYolo ? "yolo" : "api",
        stage: isYolo ? "yolo" : "zero_shot",
        meta: { backend: m.backend, notes: m.notes, metrics: m.metrics, license: m.license },
      })
      .onConflictDoNothing();
  }
  console.log(`[demo:seed] models: ${bundle.models.length}`);

  await getPool().end();
}

main().catch(async (err) => {
  console.error("[demo:seed] FAILED:", err instanceof Error ? err.message : err);
  try {
    await getPool().end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
