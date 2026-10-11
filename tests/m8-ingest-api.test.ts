/**
 * M8 task C1 — HTTP contract for `POST /models/register` and `POST /ingest/metrics`
 * (plan §10.1) through real Request/Response objects, on BOTH stores.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { LocalStorageAdapter } from "@/shared/storage/adapter";
import { mintWorkerToken } from "@/shared/jobs/tokens";
import * as W from "@/shared/jobs/worker-handlers";
import { MAX_METRICS_PER_REQUEST } from "@/shared/contracts/ingest";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-ingest-api] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function req(path: string, o: { token?: string | null; version?: string | null; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.version !== null) headers["x-contract-version"] = o.version ?? "1";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  return new Request(`http://test.local/api/worker/v1${path}`, {
    method: "POST",
    headers,
    body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
}

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("models/register + ingest/metrics HTTP — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("contract", () => {
    let store: OrgStore;
    let a: OrgRecord;
    let b: OrgRecord;
    let tokA: string;
    let tokB: string;
    let readTok: string;
    let deps: { store: OrgStore; storage: LocalStorageAdapter };

    const mk = async (org: OrgRecord, name: string, scopes: "jobs:read" | "jobs:write") => {
      const m = mintWorkerToken();
      await store.scoped(org.id).createWorkerToken({ name, tokenHash: m.tokenHash, scopes });
      return m.token;
    };
    const artifact = (org: OrgRecord, kind: "model" | "tool_image") =>
      store.scoped(org.id).createArtifact({ kind, storageKey: `k/${Math.random()}`, mime: "application/octet-stream", width: null, height: null, bytes: 1, sha256: "0".repeat(64), provenance: "worker_exact" });

    beforeAll(async () => {
      store = make();
      a = await store.createOrg({ slug: `m8a-a-${suffix}`, name: "A" });
      b = await store.createOrg({ slug: `m8a-b-${suffix}`, name: "B" });
      tokA = await mk(a, "w", "jobs:write");
      tokB = await mk(b, "w", "jobs:write");
      readTok = await mk(a, "ro", "jobs:read");
      deps = { store, storage: new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-m8i-")), { secret: "test-secret-test-secret-test-secret-0123" }) };
    });
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, [a.id, b.id]));
    });

    const model = (o: Parameters<typeof req>[1]) => W.registerModel(req("/models/register", o), deps);
    const metrics = (o: Parameters<typeof req>[1]) => W.ingestMetrics(req("/ingest/metrics", o), deps);
    const issues = async (res: Response) => ((await res.json()) as { code: string; detail?: string; issues?: string[] });

    // ------------------------------------------------------------ shared auth
    it.each([
      ["models/register", (o: Parameters<typeof req>[1]) => model(o)],
      ["ingest/metrics", (o: Parameters<typeof req>[1]) => metrics(o)],
    ] as const)("%s: contract header, bearer token and scope are enforced as problem+json", async (_n, call) => {
      const body = { name: "x", kind: "vlm", stage: "sft", run: { kind: "sft", name: "x" } };
      expect((await call({ token: tokA, version: null, body })).status).toBe(400);
      expect((await call({ token: tokA, version: "2", body })).status).toBe(426);
      expect((await call({ token: null, body })).status).toBe(401);
      expect((await call({ token: "tf_wrk_nope", body })).status).toBe(401);
      const ro = await call({ token: readTok, body });
      expect(ro.status).toBe(403); // a read-only token cannot write
      expect(ro.headers.get("content-type")).toContain("application/problem+json");
    });

    it("malformed JSON is a 400 problem, not a crash", async () => {
      const res = await model({ token: tokA, raw: "{not json" });
      expect(res.status).toBe(400);
      expect((await issues(res)).code).toBe("invalid_request");
    });

    // ------------------------------------------------------------ models/register
    it("models/register: creates, then replays as an update and keeps omitted fields", async () => {
      const first = await model({ token: tokA, body: { name: "qwen-sft", kind: "vlm", stage: "sft", hfPath: "me/m/sft", meta: { rank: 16 } } });
      expect(first.status).toBe(200);
      const f = (await first.json()) as { modelId: string; created: boolean; name: string; kind: string; stage: string };
      expect(f).toMatchObject({ created: true, name: "qwen-sft", kind: "vlm", stage: "sft" });

      const replay = await model({ token: tokA, body: { name: "qwen-sft", kind: "vlm", stage: "sft" } });
      const r = (await replay.json()) as { modelId: string; created: boolean };
      expect(r).toEqual(expect.objectContaining({ created: false, modelId: f.modelId }));
      const stored = (await store.scoped(a.id).listModels()).find((m) => m.id === f.modelId)!;
      expect(stored).toMatchObject({ hfPath: "me/m/sft", meta: { rank: 16 } }); // omitted = kept
    });

    it("models/register: rejects invalid input with 422 and stores nothing", async () => {
      const before = (await store.scoped(a.id).listModels()).length;
      const bad: unknown[] = [
        { kind: "vlm", stage: "sft" }, // no name
        { name: "  ", kind: "vlm", stage: "sft" },
        { name: "x", kind: "gpt", stage: "sft" },
        { name: "x", kind: "vlm", stage: "yolo" }, // yolo stage needs yolo kind
        { name: "x", kind: "yolo", stage: "sft" },
        { name: "x", kind: "vlm", stage: "sft", onnxArtifactId: "not-a-uuid" },
        { name: "x", kind: "vlm", stage: "sft", meta: "string" },
      ];
      for (const body of bad) {
        const res = await model({ token: tokA, body });
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect((await issues(res)).code).toBe("validation_failed");
      }
      expect((await store.scoped(a.id).listModels()).length).toBe(before);
    });

    it("models/register: the ONNX artifact must be a `model` artifact of THIS org", async () => {
      const ok = await artifact(a, "model");
      const wrongKind = await artifact(a, "tool_image");
      const foreign = await artifact(b, "model");
      const base = { name: "yolo-onnx", kind: "yolo", stage: "yolo" } as const;

      for (const id of [wrongKind.id, foreign.id, "00000000-0000-4000-8000-000000000000"]) {
        const res = await model({ token: tokA, body: { ...base, onnxArtifactId: id } });
        expect(res.status).toBe(422); // another org's artifact is indistinguishable from a missing one
      }
      expect((await store.scoped(a.id).listModels()).find((m) => m.name === "yolo-onnx")).toBeUndefined();

      const good = await model({ token: tokA, body: { ...base, onnxArtifactId: ok.id } });
      expect(good.status).toBe(200);
      // a later re-register without the artifact keeps the export
      await model({ token: tokA, body: { ...base, hfPath: "me/m/yolo" } });
      expect((await store.scoped(a.id).listModels()).find((m) => m.name === "yolo-onnx")).toMatchObject({ onnxArtifactId: ok.id, hfPath: "me/m/yolo" });
    });

    it("models/register: tenants are isolated (same name+stage in another org is created fresh)", async () => {
      const mine = (await (await model({ token: tokA, body: { name: "iso", kind: "api", stage: "zero_shot" } })).json()) as { modelId: string; created: boolean };
      const theirs = (await (await model({ token: tokB, body: { name: "iso", kind: "api", stage: "zero_shot" } })).json()) as { modelId: string; created: boolean };
      expect(mine.created && theirs.created).toBe(true);
      expect(mine.modelId).not.toBe(theirs.modelId);
    });

    // ------------------------------------------------------------ ingest/metrics
    const body = (over: Record<string, unknown> = {}) => ({
      run: { kind: "grpo", name: "r1", config: { k: 8 } },
      metrics: [{ step: 1, name: "loss", value: 0.5 }, { step: 2, name: "loss", value: 0.25 }],
      rewardSamples: [{ step: 1, trajectoryRef: "img1:g0:k0", components: { accuracy: 1 }, total: 1 }],
      ...over,
    });

    it("ingest/metrics: first call creates the run; replaying it changes nothing", async () => {
      const first = await metrics({ token: tokA, body: body() });
      expect(first.status).toBe(200);
      const f = (await first.json()) as { runId: string; runCreated: boolean; status: string; metrics: unknown; rewardSamples: unknown };
      expect(f).toMatchObject({ runCreated: true, status: "running", metrics: { received: 2, inserted: 2 }, rewardSamples: { received: 1, inserted: 1 } });

      const replay = (await (await metrics({ token: tokA, body: body() })).json()) as typeof f;
      expect(replay).toMatchObject({ runId: f.runId, runCreated: false, metrics: { received: 2, inserted: 0 }, rewardSamples: { received: 1, inserted: 0 } });
      expect((await store.scoped(a.id).listTrainingMetrics(f.runId)).length).toBe(2);
    });

    it("ingest/metrics: a status-only call is allowed and a finished run cannot be reopened", async () => {
      const run = (status?: string) => ({ run: { kind: "sft", name: "status-run", ...(status ? { status } : {}) }, metrics: [], rewardSamples: [] });
      const done = (await (await metrics({ token: tokA, body: run("succeeded") })).json()) as { status: string };
      expect(done.status).toBe("succeeded");
      const late = (await (await metrics({ token: tokA, body: run("running") })).json()) as { status: string };
      expect(late.status).toBe("succeeded"); // the response tells the worker what is actually stored
    });

    it("ingest/metrics: rejects bad batches with 422 and writes nothing (not even the run)", async () => {
      const dupMetric = { step: 1, name: "loss", value: 1 };
      const cases: [string, unknown][] = [
        ["duplicate metric key in one batch", body({ run: { kind: "sft", name: "bad-1" }, metrics: [dupMetric, dupMetric] })],
        ["duplicate reward sample key", body({ run: { kind: "sft", name: "bad-2" }, rewardSamples: [{ step: 1, trajectoryRef: "t", components: {}, total: 1 }, { step: 1, trajectoryRef: "t", components: {}, total: 2 }] })],
        ["unknown run kind", body({ run: { kind: "dpo", name: "bad-3" } })],
        ["blank run name", body({ run: { kind: "sft", name: " " } })],
        ["negative step", body({ run: { kind: "sft", name: "bad-4" }, metrics: [{ step: -1, name: "loss", value: 1 }] })],
        ["fractional step", body({ run: { kind: "sft", name: "bad-5" }, metrics: [{ step: 1.5, name: "loss", value: 1 }] })],
        ["value beyond float32", body({ run: { kind: "sft", name: "bad-6" }, metrics: [{ step: 1, name: "loss", value: 1e39 }] })],
        ["value is a string", body({ run: { kind: "sft", name: "bad-7" }, metrics: [{ step: 1, name: "loss", value: "0.5" }] })],
        ["too many metrics", body({ run: { kind: "sft", name: "bad-8" }, metrics: Array.from({ length: MAX_METRICS_PER_REQUEST + 1 }, (_, i) => ({ step: i, name: "l", value: 0 })) })],
        ["no run at all", { metrics: [] }],
      ];
      for (const [label, payload] of cases) {
        const res = await metrics({ token: tokA, body: payload });
        expect(res.status, label).toBe(422);
        expect((await issues(res)).code, label).toBe("validation_failed");
      }
      const names = (await store.scoped(a.id).listTrainingRuns()).map((r) => r.name);
      expect(names.filter((n) => n.startsWith("bad-"))).toEqual([]);
    });

    it("ingest/metrics: the duplicate-key message names both positions", async () => {
      const dup = { step: 3, name: "loss", value: 1 };
      const res = await metrics({ token: tokA, body: body({ run: { kind: "sft", name: "bad-msg" }, metrics: [dup, { step: 4, name: "loss", value: 1 }, dup] }) });
      expect(((await issues(res)).detail ?? "")).toContain("metrics.2: duplicate of metrics[0]");
    });

    it("ingest/metrics: tenants are isolated (same run name in another org is a different run)", async () => {
      const mine = (await (await metrics({ token: tokA, body: body({ run: { kind: "yolo", name: "iso-run" } }) })).json()) as { runId: string };
      const theirs = (await (await metrics({ token: tokB, body: body({ run: { kind: "yolo", name: "iso-run" } }) })).json()) as { runId: string; runCreated: boolean };
      expect(theirs.runCreated).toBe(true);
      expect(theirs.runId).not.toBe(mine.runId);
      expect(await store.scoped(b.id).listTrainingMetrics(mine.runId)).toEqual([]);
    });

    it("both endpoints stay documented as implemented in the generated contract", async () => {
      const { buildWorkerOpenApi } = await import("@/shared/contracts/openapi");
      const paths = buildWorkerOpenApi().paths as Record<string, { post: Record<string, unknown> }>;
      expect(paths["/models/register"]!.post["x-implemented"]).not.toBe(false);
      expect(paths["/ingest/metrics"]!.post["x-implemented"]).not.toBe(false);
      expect(paths["/ingest/traces"]!.post["x-implemented"]).not.toBe(false); // implemented in C2a (ADR-0012)
      expect(paths["/ingest/eval-run"]!.post["x-implemented"]).not.toBe(false); // implemented in C2b (ADR-0013)
    });
  });
});
