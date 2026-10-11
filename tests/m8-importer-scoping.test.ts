/**
 * Importer DB writer (`src/shared/lib/import/db.ts`) — tenant scoping regression tests.
 *
 * The M7 importer had NO database-level tests (only parsing). Its eval-run lookup used `source_file`
 * across ALL organizations, so a second org importing the same file was told "already imported" and
 * silently got no data. The trace lookup read every tenant's traces. Both are now org-scoped.
 * Postgres only: CI fails if it is absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import * as s from "@/shared/db/schema";
import { emptyStats, ensureDatasets, insertEvalRows, insertTraceRows, replaceEvalRunsBySourceFile } from "@/shared/lib/import/db";
import { parseEvalFile, parseTraceLine, traceFileMeta } from "@/shared/lib/import/parse";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-importer-scoping] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fixture = (dir: string, name: string) => readFileSync(join(process.cwd(), "fixtures", dir, name), "utf8");

describe.skipIf(!dbUp)("importer DB writer is tenant-scoped", () => {
  const db = getPgDb();
  const store = new DrizzleOrgStore(db);
  let a = "";
  let b = "";

  beforeAll(async () => {
    a = (await store.createOrg({ slug: `m8imp-a-${suffix}`, name: "A" })).id;
    b = (await store.createOrg({ slug: `m8imp-b-${suffix}`, name: "B" })).id;
  });
  afterAll(async () => {
    await db.delete(s.organizations).where(inArray(s.organizations.id, [a, b]));
  });

  it("two organizations importing the SAME eval file each get their own run", async () => {
    const parsed = parseEvalFile("zero_shot_scoping_test.jsonl", [JSON.stringify(JSON.parse(fixture("evals", "qwen.json")))])!;
    expect(parsed).not.toBeNull();

    const statsA = emptyStats(a);
    await insertEvalRows(db, a, parsed, statsA);
    expect(statsA).toMatchObject({ evalRunsInserted: 1, evalRunsExisting: 0, evalCasesInserted: 1 });

    const statsB = emptyStats(b);
    await insertEvalRows(db, b, parsed, statsB);
    // before the fix: evalRunsExisting 1, evalRunsInserted 0 — org B silently lost the run
    expect(statsB).toMatchObject({ evalRunsInserted: 1, evalRunsExisting: 0, evalCasesInserted: 1 });

    // re-importing within ONE org is still idempotent
    const again = emptyStats(a);
    await insertEvalRows(db, a, parsed, again);
    expect(again).toMatchObject({ evalRunsInserted: 0, evalRunsExisting: 1, evalCasesInserted: 0 });

    for (const org of [a, b]) {
      expect(await db.select().from(s.evalRuns).where(eq(s.evalRuns.orgId, org))).toHaveLength(1);
      expect(await db.select().from(s.evalCases).where(eq(s.evalCases.orgId, org))).toHaveLength(1);
    }
  });

  it("two organizations importing the same traces each get their own rows, and re-import stays idempotent", async () => {
    const line = JSON.stringify(JSON.parse(fixture("traces", "verified_with_tools.json")));
    const row = parseTraceLine(line, "train_cot_traces_dentex.jsonl", traceFileMeta("train_cot_traces_dentex.jsonl"))!;
    expect(row).not.toBeNull();
    const noImages = () => null; // placeholder image rows, as the importer does for missing files

    const results: Record<string, ReturnType<typeof emptyStats>> = {};
    for (const org of [a, b]) {
      const datasets = await ensureDatasets(db, org);
      const stats = emptyStats(org);
      await insertTraceRows(db, org, datasets.get("dentex")!, [row], noImages, stats);
      results[org] = stats;
    }
    expect(results[a]).toMatchObject({ tracesInserted: 1, tracesDeduped: 0 });
    expect(results[b]).toMatchObject({ tracesInserted: 1, tracesDeduped: 0 });

    const datasets = await ensureDatasets(db, a);
    const again = emptyStats(a);
    await insertTraceRows(db, a, datasets.get("dentex")!, [row], noImages, again);
    expect(again).toMatchObject({ tracesInserted: 0, tracesDeduped: 1 });

    for (const org of [a, b]) {
      expect(await db.select().from(s.traces).where(eq(s.traces.orgId, org))).toHaveLength(1);
    }
  });

  it("a run imported before ADR-0014 (cases dropped) is detected as STALE and repaired by a scoped replace", async () => {
    const base = JSON.parse(fixture("evals", "qwen.json")) as Record<string, unknown>;
    const goodLine = (n: number) => JSON.stringify({ ...base, image_id: n });
    // what the OLD contract could not represent: a whole FDI code in a prediction's tooth_position
    const quirkyLine = (n: number) =>
      JSON.stringify({ ...base, image_id: n, predictions: [{ quadrant: 3, tooth_position: 36, diagnosis: "x", confidence: null }], confidence: null });
    const file = "zero_shot_stale_test.jsonl";
    const full = parseEvalFile(file, [goodLine(1), goodLine(2), goodLine(3), quirkyLine(4), quirkyLine(5)])!;
    const truncated = parseEvalFile(file, [goodLine(1), goodLine(2), goodLine(3)])!; // as the old importer saw the file
    expect([full.run.n, truncated.run.n]).toEqual([5, 3]);

    // org A imported the truncated run; org B (later) imported the full one; A also has an API-ingested run
    await insertEvalRows(db, a, truncated, emptyStats(a));
    await insertEvalRows(db, b, full, emptyStats(b));
    const api = await store.scoped(a).ingestEvalCases({
      runKey: "api-run",
      run: { dataset: "dentex", split: "test", provider: "p", model: "m", canonicalResize: false },
      cases: [{ ...full.cases[0]!, sourceImageId: 1 }],
    });
    if (api.outcome !== "ok") throw new Error("api run");

    // re-importing the full file: "already imported" is reported as STALE, nothing is silently kept as fine
    const again = emptyStats(a);
    await insertEvalRows(db, a, full, again);
    expect(again).toMatchObject({ evalRunsExisting: 1, evalRunsInserted: 0, evalRunsStale: 1, evalCasesInserted: 0 });

    // a complete run is not stale
    const bAgain = emptyStats(b);
    await insertEvalRows(db, b, full, bAgain);
    expect(bAgain).toMatchObject({ evalRunsExisting: 1, evalRunsStale: 0 });

    const bBefore = (await db.select().from(s.evalRuns).where(eq(s.evalRuns.orgId, b))).find((r) => r.sourceFile === file)!;

    // the scoped replace removes only A's file-imported run for this file …
    expect(await replaceEvalRunsBySourceFile(db, a, file)).toBe(1);
    expect(await replaceEvalRunsBySourceFile(db, a, "api:api-run")).toBe(0); // API-ingested runs are never touched
    const fixed = emptyStats(a);
    await insertEvalRows(db, a, full, fixed);
    expect(fixed).toMatchObject({ evalRunsInserted: 1, evalCasesInserted: 5, evalRunsStale: 0 });

    const aRuns = await db.select().from(s.evalRuns).where(eq(s.evalRuns.orgId, a));
    expect(aRuns.find((r) => r.sourceFile === file)!.n).toBe(5);
    expect(aRuns.some((r) => r.runKey === "api-run")).toBe(true);
    // … and B's run is the very same row, untouched
    const bAfter = (await db.select().from(s.evalRuns).where(eq(s.evalRuns.orgId, b))).find((r) => r.sourceFile === file)!;
    expect(bAfter.id).toBe(bBefore.id);
    expect((await db.select().from(s.evalCases).where(eq(s.evalCases.runId, bAfter.id))).length).toBe(5);
  });
});
