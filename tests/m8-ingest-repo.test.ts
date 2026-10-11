/**
 * M8 task C1 — model registry + training ingestion at the repository level.
 * ONE suite, TWO backends (memory + Postgres); the DB half fails CI if Postgres is absent.
 *
 * Pins: upsert semantics ("omitted keeps"), idempotent re-send, status that never
 * moves backwards, atomicity of a rejected batch, float32 parity between stores,
 * ordering parity (COLLATE "C"), chunked large batches and cross-tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { mergeRunStatus, toFloat4 } from "@/shared/db/ingest-rules";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-ingest-repo] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe("pure rules", () => {
  it("mergeRunStatus only moves forward and terminal is final", () => {
    expect(mergeRunStatus("queued", "running")).toBe("running");
    expect(mergeRunStatus("running", "queued")).toBe("running");
    expect(mergeRunStatus("running", "succeeded")).toBe("succeeded");
    expect(mergeRunStatus("succeeded", "running")).toBe("succeeded");
    expect(mergeRunStatus("succeeded", "failed")).toBe("succeeded");
    expect(mergeRunStatus("failed", "succeeded")).toBe("failed");
    expect(mergeRunStatus("running", undefined)).toBe("running");
  });
  it("toFloat4 yields the shortest decimal that round-trips to the same float32", () => {
    expect(toFloat4(0.1)).toBe(0.1);
    expect(toFloat4(1 / 3)).toBe(0.33333334);
    expect(toFloat4(-2.5)).toBe(-2.5);
    expect(toFloat4(0)).toBe(0);
    expect(Math.fround(toFloat4(123456.789))).toBe(Math.fround(123456.789));
  });
});

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("model registry + training ingestion — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("repos", () => {
    let store: OrgStore;
    let a: OrgRecord;
    let b: OrgRecord;

    beforeAll(async () => {
      store = make();
      a = await store.createOrg({ slug: `m8i-a-${suffix}`, name: "A" });
      b = await store.createOrg({ slug: `m8i-b-${suffix}`, name: "B" });
    });
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().delete(organizations).where(inArray(organizations.id, [a.id, b.id]));
      }
    });

    // ------------------------------------------------------------ models
    it("registerModel upserts by (name, stage); omitted optional fields keep their stored value", async () => {
      const r = store.scoped(a.id);
      const first = await r.registerModel({
        name: "qwen-dental",
        kind: "vlm",
        stage: "sft",
        hfPath: "me/models/sft",
        meta: { rank: 16 },
      });
      expect(first.created).toBe(true);
      expect(first.model).toMatchObject({ name: "qwen-dental", kind: "vlm", stage: "sft", hfPath: "me/models/sft", onnxArtifactId: null, meta: { rank: 16 } });

      // re-register with nothing optional: everything stored is kept
      const again = await r.registerModel({ name: "qwen-dental", kind: "vlm", stage: "sft" });
      expect(again.created).toBe(false);
      expect(again.model.id).toBe(first.model.id);
      expect(again.model).toMatchObject({ hfPath: "me/models/sft", meta: { rank: 16 } });

      // provided fields replace; meta is replaced wholesale, not merged
      const upd = await r.registerModel({ name: "qwen-dental", kind: "vlm", stage: "sft", hfPath: "me/models/sft-v2", meta: { alpha: 32 } });
      expect(upd.created).toBe(false);
      expect(upd.model).toMatchObject({ hfPath: "me/models/sft-v2", meta: { alpha: 32 } });

      // same name, different stage = a different model
      const grpo = await r.registerModel({ name: "qwen-dental", kind: "vlm", stage: "grpo" });
      expect(grpo.created).toBe(true);
      expect(grpo.model.id).not.toBe(first.model.id);

      expect((await r.listModels()).map((m) => `${m.name}/${m.stage}`)).toEqual(["qwen-dental/sft", "qwen-dental/grpo"]);
    });

    it("registerModel is tenant-scoped: the same (name, stage) in another org is a separate model", async () => {
      const mine = await store.scoped(a.id).registerModel({ name: "shared-name", kind: "yolo", stage: "yolo" });
      const theirs = await store.scoped(b.id).registerModel({ name: "shared-name", kind: "yolo", stage: "yolo" });
      expect(mine.created && theirs.created).toBe(true);
      expect(mine.model.id).not.toBe(theirs.model.id);
      expect((await store.scoped(b.id).listModels()).map((m) => m.orgId)).toEqual([b.id]);
    });

    // ------------------------------------------------------------ runs + metrics
    it("ingestTraining creates the run (status defaults to running) and is idempotent on re-send", async () => {
      const r = store.scoped(a.id);
      const input = {
        run: { kind: "grpo" as const, name: "grpo-1", config: { k: 8 } },
        metrics: [
          { step: 1, name: "loss", value: 0.5 },
          { step: 1, name: "reward", value: 0.25 },
          { step: 2, name: "loss", value: 0.4 },
        ],
        rewardSamples: [{ step: 1, trajectoryRef: "img7:g0:k1", components: { accuracy: 1, format: 0.5 }, total: 1.5 }],
      };
      const first = await r.ingestTraining(input);
      expect(first).toMatchObject({ runCreated: true, metricsInserted: 3, rewardSamplesInserted: 1 });
      expect(first.run).toMatchObject({ kind: "grpo", name: "grpo-1", status: "running", config: { k: 8 } });

      const second = await r.ingestTraining(input); // a retried batch
      expect(second).toMatchObject({ runCreated: false, metricsInserted: 0, rewardSamplesInserted: 0 });
      expect(second.run.id).toBe(first.run.id);

      expect(await r.listTrainingMetrics(first.run.id)).toEqual([
        { runId: first.run.id, step: 1, name: "loss", value: 0.5 },
        { runId: first.run.id, step: 1, name: "reward", value: 0.25 },
        { runId: first.run.id, step: 2, name: "loss", value: 0.4 },
      ]);
      expect((await r.listRewardSamples(first.run.id)).length).toBe(1);
      expect((await r.listTrainingRuns()).filter((x) => x.name === "grpo-1")).toHaveLength(1);
    });

    it("a re-sent key overwrites (latest value wins) and only genuinely new keys count as inserted", async () => {
      const r = store.scoped(a.id);
      const run = { kind: "sft" as const, name: "overwrite" };
      await r.ingestTraining({ run, metrics: [{ step: 1, name: "loss", value: 1 }], rewardSamples: [{ step: 1, trajectoryRef: "t", components: { a: 1 }, total: 1 }] });
      const out = await r.ingestTraining({
        run,
        metrics: [
          { step: 1, name: "loss", value: 0.75 },
          { step: 2, name: "loss", value: 0.5 },
        ],
        rewardSamples: [
          { step: 1, trajectoryRef: "t", components: { a: 2, b: 3 }, total: 5 },
          { step: 1, trajectoryRef: "u", components: {}, total: 0 },
        ],
      });
      expect(out).toMatchObject({ metricsInserted: 1, rewardSamplesInserted: 1 });
      expect((await r.listTrainingMetrics(out.run.id)).map((m) => [m.step, m.value])).toEqual([[1, 0.75], [2, 0.5]]);
      const rewards = await r.listRewardSamples(out.run.id);
      expect(rewards.map((x) => [x.trajectoryRef, x.total, x.components])).toEqual([
        ["t", 5, { a: 2, b: 3 }],
        ["u", 0, {}],
      ]);
    });

    it("config is kept when omitted and replaced when provided", async () => {
      const r = store.scoped(a.id);
      const run = { kind: "yolo" as const, name: "cfg" };
      await r.ingestTraining({ run: { ...run, config: { lr: 0.01 } }, metrics: [], rewardSamples: [] });
      expect((await r.ingestTraining({ run, metrics: [], rewardSamples: [] })).run.config).toEqual({ lr: 0.01 });
      expect((await r.ingestTraining({ run: { ...run, config: { lr: 0.1 } }, metrics: [], rewardSamples: [] })).run.config).toEqual({ lr: 0.1 });
    });

    it("run status never moves backwards, and a finished run is final", async () => {
      const r = store.scoped(a.id);
      const spec = (status?: "queued" | "running" | "succeeded" | "failed") => ({ run: { kind: "sft" as const, name: "status", ...(status ? { status } : {}) }, metrics: [], rewardSamples: [] });
      expect((await r.ingestTraining(spec("queued"))).run.status).toBe("queued");
      expect((await r.ingestTraining(spec("running"))).run.status).toBe("running");
      expect((await r.ingestTraining(spec("queued"))).run.status).toBe("running"); // backwards ignored
      expect((await r.ingestTraining(spec("succeeded"))).run.status).toBe("succeeded");
      expect((await r.ingestTraining(spec("running"))).run.status).toBe("succeeded"); // a late retry cannot reopen it
      expect((await r.ingestTraining(spec("failed"))).run.status).toBe("succeeded"); // terminal is final
      expect((await r.ingestTraining(spec())).run.status).toBe("succeeded");
    });

    it("values are stored as float32 and read back identically on both stores", async () => {
      const r = store.scoped(a.id);
      const values = [0.1, 1 / 3, 123456.789, 1e-8, -2.5, Math.PI, 16777217, 0];
      const out = await r.ingestTraining({
        run: { kind: "sft", name: "float4" },
        metrics: values.map((value, i) => ({ step: i, name: "v", value })),
        rewardSamples: values.map((total, i) => ({ step: i, trajectoryRef: "x", components: { raw: total }, total })),
      });
      const metrics = await r.listTrainingMetrics(out.run.id);
      expect(metrics.map((m) => m.value)).toEqual(values.map(toFloat4));
      const rewards = await r.listRewardSamples(out.run.id);
      expect(rewards.map((x) => x.total)).toEqual(values.map(toFloat4));
      // components are jsonb: full double precision survives untouched
      expect(rewards.map((x) => x.components.raw)).toEqual(values);
    });

    it("list order is (step, name) by byte order — identical on both stores", async () => {
      const r = store.scoped(a.id);
      const out = await r.ingestTraining({
        run: { kind: "sft", name: "order" },
        metrics: ["b", "A", "a_1", "Z", "a"].map((name) => ({ step: 1, name, value: 1 })).concat([{ step: 0, name: "zzz", value: 1 }]),
        rewardSamples: [],
      });
      expect((await r.listTrainingMetrics(out.run.id)).map((m) => `${m.step}:${m.name}`)).toEqual(["0:zzz", "1:A", "1:Z", "1:a", "1:a_1", "1:b"]);
    });

    it("a rejected batch is atomic: nothing is written, not even the run", async () => {
      const r = store.scoped(a.id);
      const dup = { step: 1, name: "loss", value: 1 };
      await expect(
        r.ingestTraining({ run: { kind: "sft", name: "atomic" }, metrics: [dup, dup], rewardSamples: [] }),
      ).rejects.toThrow();
      expect((await r.listTrainingRuns()).map((x) => x.name)).not.toContain("atomic");
      await expect(
        r.ingestTraining({
          run: { kind: "sft", name: "atomic-2" },
          metrics: [],
          rewardSamples: [
            { step: 1, trajectoryRef: "t", components: {}, total: 1 },
            { step: 1, trajectoryRef: "t", components: {}, total: 2 },
          ],
        }),
      ).rejects.toThrow();
      expect((await r.listTrainingRuns()).map((x) => x.name)).not.toContain("atomic-2");
    });

    it("large batches work (chunked inserts)", async () => {
      const r = store.scoped(a.id);
      const metrics = Array.from({ length: 5000 }, (_, i) => ({ step: i, name: "loss", value: i / 1000 }));
      const first = await r.ingestTraining({ run: { kind: "sft", name: "big" }, metrics, rewardSamples: [] });
      expect(first.metricsInserted).toBe(5000);
      const again = await r.ingestTraining({ run: { kind: "sft", name: "big" }, metrics, rewardSamples: [] });
      expect(again.metricsInserted).toBe(0);
      expect((await r.listTrainingMetrics(first.run.id)).length).toBe(5000);
    });

    it("cross-tenant: the same run name is a different run, and another org's run id reads as empty", async () => {
      const mine = await store.scoped(a.id).ingestTraining({
        run: { kind: "grpo", name: "tenant-run" },
        metrics: [{ step: 1, name: "loss", value: 9 }],
        rewardSamples: [{ step: 1, trajectoryRef: "t", components: {}, total: 9 }],
      });
      const theirs = await store.scoped(b.id).ingestTraining({
        run: { kind: "grpo", name: "tenant-run" },
        metrics: [{ step: 1, name: "loss", value: 1 }],
        rewardSamples: [],
      });
      expect(theirs.runCreated).toBe(true);
      expect(theirs.run.id).not.toBe(mine.run.id);
      expect((await store.scoped(b.id).listTrainingMetrics(theirs.run.id)).map((m) => m.value)).toEqual([1]);
      // B asking for A's run id sees nothing, for both tables
      expect(await store.scoped(b.id).listTrainingMetrics(mine.run.id)).toEqual([]);
      expect(await store.scoped(b.id).listRewardSamples(mine.run.id)).toEqual([]);
      // and A's data is untouched by B's write
      expect((await store.scoped(a.id).listTrainingMetrics(mine.run.id)).map((m) => m.value)).toEqual([9]);
      expect((await store.scoped(b.id).listTrainingRuns()).every((x) => x.orgId === b.id)).toBe(true);
    });
  });
});
