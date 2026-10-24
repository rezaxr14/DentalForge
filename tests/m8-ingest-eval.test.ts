/**
 * M8 task C2b — `POST /ingest/eval-run` (plan §10.1, ADR-0013): shared summary function, repository
 * behaviour and the HTTP contract, on BOTH stores (memory + Postgres; the DB half fails CI if Postgres is
 * absent). Cases are built from the repo's real-shaped eval fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { EvalCaseInput, OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { toFloat4 } from "@/shared/db/ingest-rules";
import { LocalStorageAdapter } from "@/shared/storage/adapter";
import { mintWorkerToken } from "@/shared/jobs/tokens";
import * as W from "@/shared/jobs/worker-handlers";
import { evalCaseRow, parseEvalFile, summarizeEval } from "@/shared/lib/import/parse";
import { EvalCase } from "@/shared/contracts/traces";
import { MAX_EVAL_CASES_PER_REQUEST } from "@/shared/contracts/ingest";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-ingest-eval] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const QWEN = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "evals", "qwen.json"), "utf8")) as Record<string, unknown> & {
  image_id: number;
  model: string;
};
/** A case for `imageId` with deterministic, float32-unrepresentable metrics derived from it. */
const mk = (imageId: number, over: Record<string, unknown> = {}) => ({
  ...QWEN,
  image_id: imageId,
  fdi_f1: imageId / 7,
  exact_f1: imageId / 11,
  closeness_score: imageId / 13,
  spatial_proximity: imageId / 17,
  diagnostic_similarity: 1 - imageId / 19,
  format_ok: imageId % 2 === 0,
  raw_output: `raw ${imageId}`,
  ...over,
});
const asInput = (imageId: number, over: Record<string, unknown> = {}): EvalCaseInput => evalCaseRow(EvalCase.parse(mk(imageId, over)));
const RUN = { dataset: "dentex", split: "test", provider: "transformers", model: "Qwen/Qwen3.5-9B", canonicalResize: false };

describe("summarizeEval / evalCaseRow (pure)", () => {
  it("computes means and the format_ok rate; empty input yields {}", () => {
    const rows = [
      { fdiF1: 1, exactF1: 0, closeness: 0.5, spatial: 0.25, diagSim: 1, formatOk: true },
      { fdiF1: 0, exactF1: 0, closeness: 0.5, spatial: 0.75, diagSim: 0, formatOk: false },
    ];
    expect(summarizeEval(rows)).toEqual({ fdi_f1: 0.5, exact_f1: 0, closeness: 0.5, spatial: 0.5, diag_sim: 0.5, format_ok_rate: 0.5 });
    expect(summarizeEval([])).toEqual({});
  });

  it("the importer and the endpoint share ONE summary: parseEvalFile's summary equals summarizeEval over its cases", () => {
    const lines = [1, 2, 3, 4, 5].map((n) => JSON.stringify(mk(n)));
    const parsed = parseEvalFile("x.jsonl", lines)!;
    expect(parsed.run.summary).toEqual(summarizeEval(parsed.cases));
    expect(Object.keys(parsed.run.summary)).toEqual(["fdi_f1", "exact_f1", "closeness", "spatial", "diag_sim", "format_ok_rate"]);
  });

  it("evalCaseRow maps the stored subset, including the two summarized metrics", () => {
    const row = evalCaseRow(EvalCase.parse(mk(3)));
    expect(row).toMatchObject({ sourceImageId: 3, fdiF1: 3 / 7, spatial: 3 / 17, diagSim: 1 - 3 / 19, rawOutput: "raw 3", formatOk: false });
    expect(row.confidence).toBe(QWEN.confidence ?? null);
  });
});

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("eval run ingestion — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;

  d("repo", () => {
    let store: OrgStore;
    let a: OrgRecord;
    let b: OrgRecord;
    beforeAll(async () => {
      store = make();
      a = await store.createOrg({ slug: `m8e-a-${suffix}`, name: "A" });
      b = await store.createOrg({ slug: `m8e-b-${suffix}`, name: "B" });
    });
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, [a.id, b.id]));
    });

    /** What the summary must be: the importer's function over the float32 values both stores hold. */
    const expectedSummary = (ids: number[]) =>
      summarizeEval(
        [...ids].sort((x, y) => x - y).map((n) => {
          const c = asInput(n);
          return { fdiF1: toFloat4(c.fdiF1), exactF1: toFloat4(c.exactF1), closeness: toFloat4(c.closeness), spatial: toFloat4(c.spatial), diagSim: toFloat4(c.diagSim), formatOk: c.formatOk };
        }),
      );

    it("creates the run, stores the cases and computes n and summary from them", async () => {
      const r = store.scoped(a.id);
      const out = await r.ingestEvalCases({ runKey: "r-create", run: RUN, cases: [1, 2, 3].map((n) => asInput(n)) });
      if (out.outcome !== "ok") throw new Error(out.outcome);
      expect(out).toMatchObject({ runCreated: true, casesInserted: 3 });
      expect(out.run).toMatchObject({ dataset: "dentex", split: "test", provider: "transformers", model: "Qwen/Qwen3.5-9B", n: 3, runKey: "r-create" });
      expect(out.run.summary).toEqual(expectedSummary([1, 2, 3]));

      const cases = await r.listEvalCases(out.run.id);
      expect(cases.map((c) => c.sourceImageId)).toEqual([1, 2, 3]);
      expect(cases[1]).toMatchObject({ rawOutput: "raw 2", formatOk: true, confidence: toFloat4(QWEN.confidence as number) });
      expect(cases[0]!.fdiF1).toBe(toFloat4(1 / 7)); // float32, identical on both stores
      expect(cases[0]!.spatial).toBe(toFloat4(1 / 17));
      expect(cases[0]!.groundTruth).toEqual(QWEN.ground_truth);
      expect((await r.listEvalRuns()).filter((x) => x.runKey === "r-create")).toHaveLength(1);
    });

    it("stores live-run provenance on the run (ADR-0025)", async () => {
      const r = store.scoped(a.id);
      const out = await r.ingestEvalCases({
        runKey: "r-provenance",
        run: { ...RUN, backend: "openai_compat", stage: "test" },
        cases: [asInput(1)],
      });
      if (out.outcome !== "ok") throw new Error(out.outcome);
      expect(out.run).toMatchObject({ backend: "openai_compat", stage: "test" });
      // A file-import run keeps the truthful NULLs.
      const imported = await r.ingestEvalCases({ runKey: "r-imported", run: RUN, cases: [asInput(2)] });
      if (imported.outcome !== "ok") throw new Error(imported.outcome);
      expect(imported.run.backend ?? null).toBeNull();
      expect(imported.run.stage ?? null).toBeNull();
    });

    it("chunked upload == one-shot upload: same n, same summary", async () => {
      const r = store.scoped(a.id);
      await r.ingestEvalCases({ runKey: "r-chunked", run: RUN, cases: [1, 2, 3].map((n) => asInput(n)) });
      const last = await r.ingestEvalCases({ runKey: "r-chunked", run: RUN, cases: [4, 5].map((n) => asInput(n)) });
      const oneShot = await r.ingestEvalCases({ runKey: "r-oneshot", run: RUN, cases: [1, 2, 3, 4, 5].map((n) => asInput(n)) });
      if (last.outcome !== "ok" || oneShot.outcome !== "ok") throw new Error("mismatch");
      expect(last.runCreated).toBe(false);
      expect(last.run.n).toBe(5);
      expect(last.run.summary).toEqual(oneShot.run.summary);
      expect(last.run.summary).toEqual(expectedSummary([1, 2, 3, 4, 5]));
    });

    it("re-sending a chunk changes nothing", async () => {
      const r = store.scoped(a.id);
      const chunk = [1, 2].map((n) => asInput(n));
      const first = await r.ingestEvalCases({ runKey: "r-idem", run: RUN, cases: chunk });
      const again = await r.ingestEvalCases({ runKey: "r-idem", run: RUN, cases: chunk });
      if (first.outcome !== "ok" || again.outcome !== "ok") throw new Error("mismatch");
      expect(again).toMatchObject({ runCreated: false, casesInserted: 0 });
      expect(again.run.id).toBe(first.run.id);
      expect(again.run.n).toBe(2);
      expect(again.run.summary).toEqual(first.run.summary);
      expect((await r.listEvalCases(first.run.id)).length).toBe(2);
    });

    it("a re-sent image overwrites its case, and the summary is RECOMPUTED (not accumulated)", async () => {
      const r = store.scoped(a.id);
      await r.ingestEvalCases({ runKey: "r-over", run: RUN, cases: [1, 2].map((n) => asInput(n)) });
      const out = await r.ingestEvalCases({ runKey: "r-over", run: RUN, cases: [asInput(2, { fdi_f1: 1, raw_output: "redone" })] });
      if (out.outcome !== "ok") throw new Error("mismatch");
      expect(out.casesInserted).toBe(0);
      expect(out.run.n).toBe(2);
      const cases = await r.listEvalCases(out.run.id);
      expect(cases[1]).toMatchObject({ sourceImageId: 2, fdiF1: 1, rawOutput: "redone" });
      expect(out.run.summary.fdi_f1).toBe((toFloat4(1 / 7) + 1) / 2);
    });

    it("a run key reused with a different dataset/split/provider/model/resize is `run_mismatch` and writes nothing", async () => {
      const r = store.scoped(a.id);
      const base = await r.ingestEvalCases({ runKey: "r-mis", run: RUN, cases: [asInput(1)] });
      if (base.outcome !== "ok") throw new Error("mismatch");
      for (const run of [
        { ...RUN, model: "other" },
        { ...RUN, dataset: "tufts" },
        { ...RUN, split: "val" },
        { ...RUN, provider: "x" },
        { ...RUN, canonicalResize: true },
      ]) {
        const out = await r.ingestEvalCases({ runKey: "r-mis", run, cases: [asInput(2)] });
        expect(out.outcome).toBe("run_mismatch");
        if (out.outcome === "run_mismatch") expect(out.run.id).toBe(base.run.id);
      }
      expect((await r.listEvalCases(base.run.id)).map((c) => c.sourceImageId)).toEqual([1]);
      expect((await r.listEvalRuns()).find((x) => x.runKey === "r-mis")).toMatchObject({ n: 1 });
    });

    it("cross-tenant: the same runKey in another org is a different run, and foreign run ids read as empty", async () => {
      const mine = await store.scoped(a.id).ingestEvalCases({ runKey: "r-iso", run: RUN, cases: [asInput(1)] });
      const theirs = await store.scoped(b.id).ingestEvalCases({ runKey: "r-iso", run: { ...RUN, model: "different" }, cases: [asInput(1), asInput(2)] });
      if (mine.outcome !== "ok" || theirs.outcome !== "ok") throw new Error("mismatch"); // B's different model is NOT a mismatch with A's run
      expect(theirs.runCreated).toBe(true);
      expect(theirs.run.id).not.toBe(mine.run.id);
      expect(await store.scoped(b.id).listEvalCases(mine.run.id)).toEqual([]);
      expect((await store.scoped(a.id).listEvalCases(mine.run.id)).length).toBe(1);
      expect((await store.scoped(b.id).listEvalRuns()).every((x) => x.orgId === b.id)).toBe(true);
    });

    it("cross-tenant replay: with the same runKey in BOTH orgs, each org's next chunk lands on its OWN run", async () => {
      // The re-read after an insert conflict only runs when your own org already holds the key; it must never
      // pick up another tenant's run that happens to share it.
      const ra = store.scoped(a.id);
      const rb = store.scoped(b.id);
      const a1 = await ra.ingestEvalCases({ runKey: "r-both", run: RUN, cases: [asInput(1)] });
      const b1 = await rb.ingestEvalCases({ runKey: "r-both", run: RUN, cases: [asInput(1), asInput(2)] });
      const b2 = await rb.ingestEvalCases({ runKey: "r-both", run: RUN, cases: [asInput(3)] }); // B's second chunk
      const a2 = await ra.ingestEvalCases({ runKey: "r-both", run: RUN, cases: [asInput(9)] }); // A's second chunk
      if (a1.outcome !== "ok" || b1.outcome !== "ok" || b2.outcome !== "ok" || a2.outcome !== "ok") throw new Error("mismatch");
      expect(b2).toMatchObject({ runCreated: false });
      expect(b2.run.id).toBe(b1.run.id);
      expect(a2.run.id).toBe(a1.run.id);
      expect(b2.run.n).toBe(3);
      expect(a2.run.n).toBe(2);
      expect((await rb.listEvalCases(b1.run.id)).map((c) => c.sourceImageId)).toEqual([1, 2, 3]);
      expect((await ra.listEvalCases(a1.run.id)).map((c) => c.sourceImageId)).toEqual([1, 9]);
    });

    it("runs created without a key (file imports) are unaffected: many may coexist", async () => {
      const r = store.scoped(a.id);
      const mkRun = () => r.createEvalRun({ dataset: "dentex", split: "test", provider: "p", model: "m", n: 0, summary: {} });
      await expect(Promise.all([mkRun(), mkRun()])).resolves.toHaveLength(2); // NULL run_key is not a unique collision
    });

    it("a chunk with a repeated image is refused atomically — no run is left behind", async () => {
      const r = store.scoped(a.id);
      await expect(r.ingestEvalCases({ runKey: "r-dup", run: RUN, cases: [asInput(1), asInput(1)] })).rejects.toThrow();
      expect((await r.listEvalRuns()).map((x) => x.runKey)).not.toContain("r-dup");
    });
  });

  // ------------------------------------------------------------------ HTTP
  d("http", () => {
    let store: OrgStore;
    let a: OrgRecord;
    let b: OrgRecord;
    let tokA: string;
    let tokB: string;
    let readTok: string;
    let deps: { store: OrgStore; storage: LocalStorageAdapter };

    const tok = async (org: OrgRecord, scopes: "jobs:read" | "jobs:write") => {
      const m = mintWorkerToken();
      await store.scoped(org.id).createWorkerToken({ name: "t", tokenHash: m.tokenHash, scopes });
      return m.token;
    };
    const call = (o: { token?: string | null; version?: string | null; body?: unknown; raw?: string }) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.version !== null) headers["x-contract-version"] = o.version ?? "1";
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      return W.ingestEvalRun(
        new Request("http://test.local/api/worker/v1/ingest/eval-run", { method: "POST", headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }),
        deps,
      );
    };
    type Out = { runId: string; runCreated: boolean; n: number; model: string; cases: { received: number; inserted: number }; summary: Record<string, number> };
    const ok = async (body: unknown, token = tokA) => {
      const res = await call({ token, body });
      expect(res.status).toBe(200);
      return (await res.json()) as Out;
    };
    const chunk = (runKey: string, ids: number[], over: Record<string, unknown> = {}) => ({ runKey, cases: ids.map((n) => mk(n)), ...over });

    beforeAll(async () => {
      store = make();
      a = await store.createOrg({ slug: `m8eh-a-${suffix}`, name: "A" });
      b = await store.createOrg({ slug: `m8eh-b-${suffix}`, name: "B" });
      tokA = await tok(a, "jobs:write");
      tokB = await tok(b, "jobs:write");
      readTok = await tok(a, "jobs:read");
      deps = { store, storage: new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-m8e-")), { secret: "test-secret-test-secret-test-secret-0123" }) };
    });
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, [a.id, b.id]));
    });

    it("contract header, bearer token and scope are enforced as problem+json", async () => {
      const body = chunk("auth", [1]);
      expect((await call({ token: tokA, version: null, body })).status).toBe(400);
      expect((await call({ token: tokA, version: "2", body })).status).toBe(426);
      expect((await call({ token: null, body })).status).toBe(401);
      const ro = await call({ token: readTok, body });
      expect(ro.status).toBe(403);
      expect(ro.headers.get("content-type")).toContain("application/problem+json");
      expect((await call({ token: tokA, raw: "{nope" })).status).toBe(400);
    });

    it("structural problems are a 422 and nothing is written", async () => {
      const { raw_output: _r, ...noRaw } = mk(1);
      void _r;
      const bad: [string, unknown][] = [
        ["no cases", { runKey: "bad", cases: [] }],
        ["too many", chunk("bad", Array.from({ length: MAX_EVAL_CASES_PER_REQUEST + 1 }, (_, i) => i + 1))],
        ["no runKey", { cases: [mk(1)] }],
        ["runKey with a space", chunk("a b", [1])],
        ["runKey starting with a dash", chunk("-x", [1])],
        ["runKey too long", chunk("k".repeat(121), [1])],
        ["mixed models in one chunk", { runKey: "bad", cases: [mk(1), mk(2, { model: "other" })] }],
        ["mixed splits in one chunk", { runKey: "bad", cases: [mk(1), mk(2, { split: "val" })] }],
        ["duplicate image_id", { runKey: "bad", cases: [mk(1), mk(1)] }],
        ["case missing raw_output", { runKey: "bad", cases: [noRaw] }],
        ["canonicalResize is a string", chunk("bad", [1], { canonicalResize: "yes" })],
      ];
      for (const [label, body] of bad) {
        const res = await call({ token: tokA, body });
        expect(res.status, label).toBe(422);
        expect(((await res.json()) as { code: string }).code, label).toBe("validation_failed");
      }
      expect((await store.scoped(a.id).listEvalRuns()).filter((r) => r.runKey === "bad")).toEqual([]);
    });

    it("creates a run chunk by chunk; n and summary always cover the whole run", async () => {
      const first = await ok(chunk("http-run", [1, 2, 3]));
      expect(first).toMatchObject({ runCreated: true, n: 3, model: "Qwen/Qwen3.5-9B", cases: { received: 3, inserted: 3 } });
      const second = await ok(chunk("http-run", [4, 5]));
      expect(second).toMatchObject({ runId: first.runId, runCreated: false, n: 5, cases: { received: 2, inserted: 2 } });

      // identical to the importer's summary over the same cases (to float32 precision)
      const fileSummary = parseEvalFile("f.jsonl", [1, 2, 3, 4, 5].map((n) => JSON.stringify(mk(n))))!.run.summary;
      expect(Object.keys(second.summary).sort()).toEqual(Object.keys(fileSummary).sort());
      for (const k of Object.keys(fileSummary)) expect(second.summary[k]!, k).toBeCloseTo(fileSummary[k]!, 6);
      expect(second.summary.format_ok_rate).toBe(2 / 5); // exact: booleans
    });

    it("replaying a chunk inserts nothing and leaves the summary alone", async () => {
      const body = chunk("http-replay", [1, 2]);
      const first = await ok(body);
      const again = await ok(body);
      expect(again).toMatchObject({ runId: first.runId, runCreated: false, n: 2, cases: { received: 2, inserted: 0 } });
      expect(again.summary).toEqual(first.summary);
    });

    it("409 run_mismatch (problem+json) when the key is reused for a different run; nothing is written", async () => {
      const first = await ok(chunk("http-mismatch", [1]));
      const res = await call({ token: tokA, body: { runKey: "http-mismatch", cases: [mk(2, { model: "someone/else" })] } });
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const p = (await res.json()) as { code: string; detail: string };
      expect(p.code).toBe("run_mismatch");
      expect(p.detail).toContain("http-mismatch");
      expect(p.detail).toContain("Qwen/Qwen3.5-9B");
      const resize = await call({ token: tokA, body: chunk("http-mismatch", [2], { canonicalResize: true }) });
      expect(resize.status).toBe(409);
      expect((await store.scoped(a.id).listEvalCases(first.runId)).map((c) => c.sourceImageId)).toEqual([1]);
    });

    it("accepts what real models emit (FDI code in tooth_position, null confidence) and keeps it as emitted — ADR-0014", async () => {
      const quirky = (n: number) =>
        mk(n, { predictions: [{ quadrant: 3, tooth_position: 36, diagnosis: "Caries", confidence: null }], confidence: null });
      const res = await ok({ runKey: "http-quirks", cases: [mk(1), quirky(2), quirky(3)] });
      expect(res).toMatchObject({ runCreated: true, n: 3, cases: { received: 3, inserted: 3 } });
      const stored = await store.scoped(a.id).listEvalCases(res.runId);
      expect(stored.map((c) => c.sourceImageId)).toEqual([1, 2, 3]);
      expect(stored[1]!.predictions).toEqual([{ quadrant: 3, tooth_position: 36, diagnosis: "Caries", confidence: null }]);
      expect(stored[1]!.confidence).toBeNull();
    });

    it("importer and endpoint accept the SAME lines (one contract, one answer)", async () => {
      const lines = [mk(1), mk(2, { predictions: [{ quadrant: 1, tooth_position: 18, diagnosis: "x", confidence: null }] }), mk(3, { confidence: null })];
      const file = parseEvalFile("parity.jsonl", lines.map((l) => JSON.stringify(l)))!;
      const res = await ok({ runKey: "http-parity", cases: lines });
      expect(res.n).toBe(file.run.n); // 3 and 3: neither path drops a case the other keeps
      for (const k of Object.keys(file.run.summary)) expect(res.summary[k]!, k).toBeCloseTo(file.run.summary[k]!, 6);
    });

    it("still refuses a real structural error, naming the case index and path, and writes nothing", async () => {
      const bad = mk(2, { ground_truth: [{ quadrant: 3, tooth_position: 36, diagnosis: "x" }] }); // ground truth stays strict
      const res = await call({ token: tokA, body: { runKey: "http-strict", cases: [mk(1), bad] } });
      expect(res.status).toBe(422);
      const p = (await res.json()) as { detail: string };
      expect(p.detail).toContain("cases.1.ground_truth.0.tooth_position");
      expect((await store.scoped(a.id).listEvalRuns()).filter((r) => r.runKey === "http-strict")).toEqual([]);
    });

    it("tenants are isolated: the same runKey in another org is its own run", async () => {
      const mine = await ok(chunk("http-iso", [1, 2]), tokA);
      const theirs = await ok({ runKey: "http-iso", cases: [mk(1, { model: "b-model" })] }, tokB); // would be a 409 if B could see A's run
      expect(theirs.runCreated).toBe(true);
      expect(theirs.runId).not.toBe(mine.runId);
      expect(await store.scoped(b.id).listEvalCases(mine.runId)).toEqual([]);
    });

    it("the generated contract now documents every worker endpoint as implemented", async () => {
      const { buildWorkerOpenApi } = await import("@/shared/contracts/openapi");
      const paths = buildWorkerOpenApi().paths as Record<string, Record<string, Record<string, unknown>>>;
      const notImplemented = Object.entries(paths).flatMap(([path, ops]) => Object.entries(ops).filter(([, op]) => op["x-implemented"] === false).map(([m]) => `${m.toUpperCase()} ${path}`));
      expect(notImplemented).toEqual([]);
    });
  });
});
