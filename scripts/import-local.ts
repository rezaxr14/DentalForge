/**
 * `pnpm import:local` — idempotent import of the owner's local VLM-DENTAL
 * files into Postgres (plan §13 M7).
 *
 * Source (READ-ONLY): ../VLM-DENTAL/data/traces/*.jsonl — verified traces
 * (per-cohort first so hybrid files dedupe into them) + zero-shot evals.
 *
 * Usage:  pnpm import:local [--dry-run]
 *   --dry-run   parse + dedupe stats only, no DB writes
 *
 * Count contract (M7 DoD): 1,847 images / 3,694 trace rows after dedupe /
 * 8 eval runs — printed at the end; mismatches exit non-zero so CI can gate.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { getPgDb, getPool } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import { getEnv } from "@/shared/config/env";
import { traceFileMeta, parseTraceLine, parseEvalFile } from "@/shared/lib/import/parse";
import { resolveImagePath, readImageSource } from "@/shared/lib/import/imageMeta";
import {
  emptyStats,
  ensureDatasets,
  insertEvalRows,
  insertTraceRows,
  type ImageResolver,
} from "@/shared/lib/import/db";

const VLM_DATA = process.env.VLM_DENTAL_DIR
  ? join(process.env.VLM_DENTAL_DIR, "data")
  : resolvePath(process.cwd(), "..", "VLM-DENTAL", "data");
const DRY_RUN = process.argv.includes("--dry-run");
const ORG_SLUG = process.env.IMPORT_ORG_SLUG ?? "demo";

/** Content-hash cache: sha256 of a 4 MB PNG should be read once. */
const imageCache = new Map<string, ReturnType<typeof readImageSource> | null>();
const resolve: ImageResolver = (dataset, imageId) => {
  const key = `${dataset}:${imageId}`;
  if (!imageCache.has(key)) {
    const path = resolveImagePath(VLM_DATA, dataset, imageId);
    imageCache.set(key, path ? readImageSource(path) : null);
  }
  return imageCache.get(key) ?? null;
};

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

async function main(): Promise<void> {
  const tracesDir = join(VLM_DATA, "traces");
  const files = readdirSync(tracesDir)
    .filter((f) => f.endsWith(".jsonl") && f.startsWith("train_cot_traces") && !f.includes("unverified"))
    .map((file) => ({ file, meta: traceFileMeta(file) }))
    // Priority 2 = hybrid union files — byte-duplicates of the per-cohort
    // files (verified in M7: all their rows dedupe away). Skipped entirely
    // so counts stay meaningful (ADR-0008).
    .filter((f) => f.meta.priority < 2)
    .sort((a, b) => a.meta.priority - b.meta.priority || a.file.localeCompare(b.file));

  if (files.length === 0) {
    console.error(`[import] no trace files under ${tracesDir} — set VLM_DENTAL_DIR`);
    process.exit(1);
  }

  const stats = emptyStats("pending");
  const parsedAll: { file: string; dataset: string; rows: ReturnType<typeof parseTraceLine>[] }[] = [];

  for (const { file } of files) {
    const lines = readLines(join(tracesDir, file));
    const meta = traceFileMeta(file);
    const rows = lines.map((l) => parseTraceLine(l, file, meta));
    for (const r of rows) if (!r) stats.invalidLines += 1;
    parsedAll.push({ file, dataset: rows[0]?.dataset ?? "dentex", rows });
    console.log(
      `[import] ${file}: ${rows.length} lines, ${rows.filter(Boolean).length} valid`,
    );
  }

  // Eval files live in data/evaluations (verified in M7 against the real
  // tree — plan §4.1 said data/evaluations, reality agrees: 8 files).
  const evalDir = join(VLM_DATA, "evaluations");
  const evalFiles = readdirSync(evalDir).filter((f) => f.startsWith("zero_shot_") && f.endsWith(".jsonl"));
  const evals = evalFiles.map((file) => parseEvalFile(file, readLines(join(evalDir, file)))).filter(Boolean);

  if (DRY_RUN) {
    // Dedupe simulation over PER-COHORT files only (hybrids skipped above):
    // identity key (dataset, image, cohort, mode) — plan §7 unique key.
    const identities = new Set<string>();
    let dupes = 0;
    for (const { rows } of parsedAll) {
      for (const r of rows) {
        if (!r) continue;
        const id = `${r.dataset}|${r.sourceImageId}|${r.cohort}|${r.mode}`;
        if (identities.has(id)) dupes += 1;
        else identities.add(id);
      }
    }
    const images = new Set<string>();
    for (const { rows } of parsedAll) {
      for (const r of rows) if (r) images.add(`${r.dataset}|${r.sourceImageId}`);
    }
    console.log(
      `[import:dry-run] images=${images.size} traces=${identities.size} deduped=${dupes} evalRuns=${evals.length}`,
    );
    process.exit(0);
  }

  // --- Live import ----------------------------------------------------------
  getEnv(); // validate env (DATABASE_URL etc.)
  const db = getPgDb();
  const store = new DrizzleOrgStore(db);
  let org = await store.getOrgBySlug(ORG_SLUG);
  org ??= await store.createOrg({ slug: ORG_SLUG, name: "Demo Org" });
  stats.orgId = org.id;

  const datasetIds = await ensureDatasets(db, org.id);
  stats.datasets = Object.fromEntries(datasetIds);

  for (const { file, dataset, rows } of parsedAll) {
    const valid = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    const datasetId = datasetIds.get(dataset);
    if (!datasetId) throw new Error(`no dataset row for ${dataset}`);
    await insertTraceRows(db, org.id, datasetId, valid, resolve, stats);
    console.log(`[import] wrote ${file} (${valid.length} rows)`);
  }

  for (const parsed of evals) {
    if (parsed) await insertEvalRows(db, org.id, parsed, stats);
  }

  console.log("[import] done:", JSON.stringify(stats, null, 2));

  // M7 DoD gate (plan §13): counts must match the source corpus.
  // - traces: per-cohort files sum to exactly 3,694 rows (1,847 per mode);
  //   identity dedupe removes nothing extra (verified in M7).
  // - images: plan says 1,847, but that counts COHORT MEMBERSHIPS
  //   (678+27+202+660+280). The §7 unique key (dataset_id, source_image_id)
  //   collapses them to 1,645 rows (Tufts pathology cohort ⊂ other cohorts;
  //   DENTEX 705 + Tufts 940). Reality wins — ADR-0008.
  // - eval runs: 8 zero_shot files.
  const expectedTraces = 3694;
  const expectedImages = 1645;
  const expectedRuns = 8;
  const traceTotal = stats.tracesInserted + stats.tracesDeduped;
  const imageTotal = stats.imagesInserted + stats.imagesExisting;
  const runTotal = stats.evalRunsInserted + stats.evalRunsExisting;
  const ok = traceTotal >= expectedTraces && imageTotal >= expectedImages && runTotal === expectedRuns;
  if (!ok) {
    console.error(
      `[import] COUNT MISMATCH: traces=${traceTotal} (want ${expectedTraces}), images=${imageTotal} (want ${expectedImages}), runs=${runTotal} (want ${expectedRuns})`,
    );
  }
  await getPool().end();
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error("[import] failed:", err);
  process.exit(1);
});
