/**
 * M8 task C2a — `POST /ingest/traces` (plan §10.1, ADR-0012): repository behaviour and the HTTP contract,
 * on BOTH stores (memory + Postgres; the DB half fails CI if Postgres is absent). Inputs are the repo's
 * real-shaped sanitized fixtures, not invented records.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { DatasetRecord, IngestTraceInput, OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { LocalStorageAdapter } from "@/shared/storage/adapter";
import { mintWorkerToken } from "@/shared/jobs/tokens";
import * as W from "@/shared/jobs/worker-handlers";
import { canonicalJson, prepareTrace } from "@/shared/jobs/trace-ingest";
import { MAX_TRACES_PER_REQUEST, IngestTrace } from "@/shared/contracts/ingest";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-ingest-traces] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fx = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "fixtures", "traces", name), "utf8")) as Record<string, unknown> & {
  image_id: number;
  dataset: string;
  turns: { turn: number; tool_calls_this_turn?: { tool_name: string; tool_ok: boolean }[] }[];
  tool_calls: number | unknown[];
};
const WITH_TOOLS = fx("verified_with_tools.json"); // dentex image 1, 4 turns, 15 stored tool-call rows
const NO_TOOLS = fx("verified_no_tools.json"); //     dentex image 1, 1 turn without a status
const HEALTHY = fx("verified_healthy.json"); //       dentex image 3
const TUFTS = fx("verified_tufts_all.json"); //       tufts  image 1

const callRows = (t: typeof WITH_TOOLS) => t.turns.flatMap((x) => x.tool_calls_this_turn ?? []);

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

/** Org with dentex (images 1, 2, 3) and, optionally, tufts (image 1) datasets. */
async function seedOrg(store: OrgStore, slug: string, withTufts = true) {
  const org = await store.createOrg({ slug, name: slug });
  const r = store.scoped(org.id);
  const dentex = await r.createDataset({ name: "DENTEX", source: "dentex" });
  const tufts: DatasetRecord | null = withTufts ? await r.createDataset({ name: "Tufts", source: "tufts" }) : null;
  const img = (ds: DatasetRecord, n: number) =>
    r.createImage({ datasetId: ds.id, sourceImageId: n, contentHash: `h-${slug}-${ds.source}-${n}`, width: 100, height: 50, storageKey: "", split: null });
  for (const n of [1, 2, 3]) await img(dentex, n);
  if (tufts) await img(tufts, 1);
  return { org, dentex, tufts };
}

describe("prepareTrace / canonicalJson (pure)", () => {
  it("canonicalJson sorts keys recursively and is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("reuses the importer's interpretation: counts, status, thought, tool calls", () => {
    const item = IngestTrace.parse(WITH_TOOLS);
    const p = prepareTrace(item, { cohort: "dentex", mode: "with_tools", verified: true }, "ds")!;
    expect(p).toMatchObject({ datasetId: "ds", sourceImageId: 1, cohort: "dentex", mode: "with_tools", verified: true, nTurns: 4, nToolCalls: 42, formatOk: true });
    expect(p.turns.map((t) => [t.idx, t.status, t.toolCalls.length])).toEqual([[0, "tool_executed", 4], [1, "tool_executed", 3], [2, "tool_executed", 4], [3, "tool_executed", 4]]);
    expect(p.turns[0]!.toolCalls[0]!.toolName).toBe(callRows(WITH_TOOLS)[0]!.tool_name);
  });

  it("the content hash ignores `messages`, `image_path` and key order, but not content", () => {
    const base = IngestTrace.parse(WITH_TOOLS);
    const src = { cohort: "dentex", mode: "with_tools", verified: true } as const;
    const h = (t: unknown) => prepareTrace(IngestTrace.parse(t), src, "ds")!.contentHash;
    const { messages: _m, image_path: _p, ...bare } = WITH_TOOLS;
    void _m;
    void _p;
    expect(h(bare)).toBe(h(WITH_TOOLS)); // omitted entirely vs present
    expect(h({ ...WITH_TOOLS, image_path: "C:\\somewhere\\else.png", messages: [{ role: "user", content: "different" }] })).toBe(h(WITH_TOOLS));
    expect(h(Object.fromEntries(Object.entries(WITH_TOOLS).reverse()))).toBe(h(WITH_TOOLS)); // key order
    expect(h({ ...WITH_TOOLS, format_ok: false })).not.toBe(h(WITH_TOOLS)); // real content change
    expect(base.image_id).toBe(1);
  });

  it("a repeated turn number is invalid (it is the storage key)", () => {
    const dup = { ...WITH_TOOLS, turns: [WITH_TOOLS.turns[0]!, WITH_TOOLS.turns[0]!] };
    expect(prepareTrace(IngestTrace.parse(dup), { cohort: "dentex", mode: "with_tools", verified: true }, "ds")).toBeNull();
  });
});

describe.each(backends)("trace ingestion — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("repo", () => {
    let store: OrgStore;
    let a: Awaited<ReturnType<typeof seedOrg>>;
    let b: Awaited<ReturnType<typeof seedOrg>>;

    const input = (dsId: string, raw: typeof WITH_TOOLS, over: Partial<IngestTraceInput> = {}, cohort = "dentex", mode: "with_tools" | "no_tools" = "with_tools"): IngestTraceInput => ({
      ...prepareTrace(IngestTrace.parse(raw), { cohort, mode, verified: true }, dsId)!,
      ...over,
    });

    beforeAll(async () => {
      store = make();
      a = await seedOrg(store, `m8t-a-${suffix}`);
      b = await seedOrg(store, `m8t-b-${suffix}`);
    }, 20_000);
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, [a.org.id, b.org.id]));
    });

    it("inserts the trace with its turns and tool calls, in order", async () => {
      const r = store.scoped(a.org.id);
      const out = await r.ingestTrace(input(a.dentex.id, WITH_TOOLS));
      if (out.outcome !== "inserted") throw new Error(out.outcome);
      expect(out.trace).toMatchObject({ cohort: "dentex", mode: "with_tools", verified: true, nTurns: 4, nToolCalls: 42, formatOk: true, orgId: a.org.id });
      expect(out.trace.verifierReason).toBe(WITH_TOOLS.verifier_reason);

      const turns = await r.listTraceTurns(out.trace.id);
      expect(turns.map((t) => t.idx)).toEqual([0, 1, 2, 3]);
      expect(turns.every((t) => t.status === "tool_executed")).toBe(true);
      const stored = turns.flatMap((t) => t.toolCalls);
      expect(stored.length).toBe(callRows(WITH_TOOLS).length); // rows, NOT the stored total of 42
      expect(stored.map((c) => c.toolName)).toEqual(callRows(WITH_TOOLS).map((c) => c.tool_name));
      expect(stored.map((c) => c.ok)).toEqual(callRows(WITH_TOOLS).map((c) => c.tool_ok));
      expect(turns[0]!.toolCalls.map((c) => c.idx)).toEqual([0, 1, 2, 3]);
      expect((await r.listTraces()).filter((t) => t.id === out.trace.id)).toHaveLength(1);
    });

    it("a turn without a status or tool calls is stored as such (single-turn no-tools trace)", async () => {
      const r = store.scoped(a.org.id);
      const out = await r.ingestTrace(input(a.dentex.id, NO_TOOLS, {}, "dentex", "no_tools"));
      if (out.outcome !== "inserted") throw new Error(out.outcome);
      const turns = await r.listTraceTurns(out.trace.id);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ idx: 0, status: "", toolCalls: [] });
      expect(turns[0]!.rawOutput).toEqual(expect.any(String)); // terminal turns carry raw_output
    });

    it("identity = (dataset, image, cohort, mode): a repeat is `existing` and writes nothing", async () => {
      const r = store.scoped(a.org.id);
      const again = await r.ingestTrace(input(a.dentex.id, WITH_TOOLS));
      if (again.outcome !== "existing") throw new Error(again.outcome);
      expect(again.sameContent).toBe(true);
      expect((await r.listTraceTurns(again.trace.id)).length).toBe(4); // untouched, not doubled
      expect((await r.listTraces()).filter((t) => t.imageId === again.trace.imageId && t.cohort === "dentex" && t.mode === "with_tools")).toHaveLength(1);
    });

    it("same identity with DIFFERENT content: the first import is kept and the difference is reported", async () => {
      const r = store.scoped(a.org.id);
      const first = await r.ingestTrace(input(a.dentex.id, HEALTHY));
      if (first.outcome !== "inserted") throw new Error(first.outcome);
      const changed = await r.ingestTrace(input(a.dentex.id, { ...HEALTHY, format_ok: false }));
      if (changed.outcome !== "existing") throw new Error(changed.outcome);
      expect(changed.sameContent).toBe(false);
      expect(changed.trace.id).toBe(first.trace.id);
      expect(changed.trace.contentHash).toBe(first.trace.contentHash); // stored hash unchanged
      expect(changed.trace.formatOk).toBe(true);
    });

    it("another cohort or mode on the same image is a different identity", async () => {
      const r = store.scoped(a.org.id);
      const otherCohort = await r.ingestTrace(input(a.dentex.id, WITH_TOOLS, {}, "healthy_dentex"));
      const otherMode = await r.ingestTrace(input(a.dentex.id, WITH_TOOLS, {}, "dentex", "no_tools"));
      expect(otherCohort.outcome).toBe("inserted");
      expect(otherMode.outcome).toBe("existing"); // NO_TOOLS above already took (dentex, image 1, no_tools)
    });

    it("rejects an unknown image or dataset, and writes nothing", async () => {
      const r = store.scoped(a.org.id);
      const before = (await r.listTraces()).length;
      expect(await r.ingestTrace(input(a.dentex.id, { ...WITH_TOOLS, image_id: 999 }))).toEqual({ outcome: "rejected", reason: "unknown_image" });
      expect(await r.ingestTrace(input("00000000-0000-4000-8000-000000000000", WITH_TOOLS))).toEqual({ outcome: "rejected", reason: "unknown_dataset" });
      expect((await r.listTraces()).length).toBe(before);
    });

    it("cross-tenant: another org's dataset is `unknown_dataset`, and its turns read as empty", async () => {
      // B tries to attach a trace to A's dataset (and therefore A's image)
      expect(await store.scoped(b.org.id).ingestTrace(input(a.dentex.id, WITH_TOOLS))).toEqual({ outcome: "rejected", reason: "unknown_dataset" });
      const aTrace = (await store.scoped(a.org.id).listTraces())[0]!;
      expect((await store.scoped(a.org.id).listTraceTurns(aTrace.id)).length).toBeGreaterThan(0);
      expect(await store.scoped(b.org.id).listTraceTurns(aTrace.id)).toEqual([]);
      // the same identity in B's own dataset is independent
      const mine = await store.scoped(b.org.id).ingestTrace(input(b.dentex.id, WITH_TOOLS));
      expect(mine.outcome).toBe("inserted");
      expect((await store.scoped(b.org.id).listTraces()).every((t) => t.orgId === b.org.id)).toBe(true);
    });

    it("a trace the database/contract cannot store is refused atomically — no half-written trace", async () => {
      const r = store.scoped(a.org.id);
      const before = (await r.listTraces()).length;
      const bad = input(a.dentex.id, TUFTS as typeof WITH_TOOLS, {}, "atomic", "with_tools");
      const dupTurns = { ...bad, sourceImageId: 2, turns: [bad.turns[0]!, bad.turns[0]!] };
      await expect(r.ingestTrace(dupTurns)).rejects.toThrow();
      const dupCalls = { ...bad, sourceImageId: 2, turns: [{ ...bad.turns[0]!, toolCalls: [bad.turns[0]!.toolCalls[0]!, bad.turns[0]!.toolCalls[0]!] }] };
      await expect(r.ingestTrace(dupCalls)).rejects.toThrow();
      expect((await r.listTraces()).length).toBe(before);
    });

    it("stores live-run provenance and the artifact id of a tool image (ADR-0025)", async () => {
      const r = store.scoped(a.org.id);
      const ARTIFACT = "00000000-0000-4000-8000-0000000000c1";
      const base = input(a.dentex.id, WITH_TOOLS, { cohort: "live", backend: "openai_compat", stage: "test" });
      const out = await r.ingestTrace({
        ...base,
        turns: base.turns.map((t, i) => ({
          ...t,
          toolCalls: t.toolCalls.map((c, j) => (i === 0 && j === 0 ? { ...c, artifactId: ARTIFACT } : c)),
        })),
      });
      if (out.outcome !== "inserted") throw new Error(out.outcome);
      expect(out.trace).toMatchObject({ backend: "openai_compat", stage: "test" });

      const turns = await r.listTraceTurns(out.trace.id);
      expect(turns[0]!.toolCalls[0]!.artifactId).toBe(ARTIFACT);
      expect(turns[1]!.toolCalls.every((c) => !c.artifactId)).toBe(true);

      // The Trace Explorer read path carries both, so the page can show the test badge and the image.
      if (store instanceof DrizzleOrgStore) {
        const { postgresSource } = await import("@/shared/lib/datasource");
        const detail = await postgresSource(getPgDb(), a.org.id).getTraceDetail(out.trace.id);
        expect(detail).toMatchObject({ backend: "openai_compat", stage: "test" });
        const call = detail!.trace.turns[0]!.tool_calls_this_turn?.[0] as { artifact_id?: string };
        expect(call.artifact_id).toBe(ARTIFACT);
      }

      // `researchOnly` drops the test backend, but Trace Explorer (no filter) still sees it.
      const byImage = await r.listTraces({ imageId: out.trace.imageId });
      expect(byImage.some((t) => t.id === out.trace.id)).toBe(true);
      const research = await r.listTraces({ imageId: out.trace.imageId, researchOnly: true });
      expect(research.some((t) => t.id === out.trace.id)).toBe(false);
      // imported traces (stage null) survive the research filter
      expect(research.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------ HTTP
  d("http", () => {
    let store: OrgStore;
    let a: Awaited<ReturnType<typeof seedOrg>>;
    let b: Awaited<ReturnType<typeof seedOrg>>;
    let noTufts: Awaited<ReturnType<typeof seedOrg>>;
    let tokA: string;
    let tokB: string;
    let tokNoTufts: string;
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
      return W.ingestTraces(
        new Request("http://test.local/api/worker/v1/ingest/traces", { method: "POST", headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }),
        deps,
      );
    };
    const src = (over: Record<string, unknown> = {}) => ({ cohort: "dentex", mode: "with_tools", ...over });
    type Out = { results: { index: number; imageId: number; outcome: string; traceId?: string; sameContent?: boolean; reason?: string }[]; inserted: number; existing: number; rejected: number };
    const ok = async (body: unknown, token = tokA) => {
      const res = await call({ token, body });
      expect(res.status).toBe(200);
      return (await res.json()) as Out;
    };

    beforeAll(async () => {
      store = make();
      a = await seedOrg(store, `m8h-a-${suffix}`);
      b = await seedOrg(store, `m8h-b-${suffix}`);
      noTufts = await seedOrg(store, `m8h-n-${suffix}`, false);
      tokA = await tok(a.org, "jobs:write");
      tokB = await tok(b.org, "jobs:write");
      tokNoTufts = await tok(noTufts.org, "jobs:write");
      readTok = await tok(a.org, "jobs:read");
      deps = { store, storage: new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-m8t-")), { secret: "test-secret-test-secret-test-secret-0123" }) };
    }, 20_000);
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().delete(organizations).where(inArray(organizations.id, [a.org.id, b.org.id, noTufts.org.id]));
      }
    });

    it("contract header, bearer token and scope are enforced as problem+json", async () => {
      const body = { source: src(), traces: [WITH_TOOLS] };
      expect((await call({ token: tokA, version: null, body })).status).toBe(400);
      expect((await call({ token: tokA, version: "2", body })).status).toBe(426);
      expect((await call({ token: null, body })).status).toBe(401);
      const ro = await call({ token: readTok, body });
      expect(ro.status).toBe(403);
      expect(ro.headers.get("content-type")).toContain("application/problem+json");
      expect((await call({ token: tokA, raw: "{nope" })).status).toBe(400);
    });

    it("structural problems are a 422 and nothing is written", async () => {
      const before = (await store.scoped(a.org.id).listTraces()).length;
      const { ground_truth: _g, ...noGt } = WITH_TOOLS;
      void _g;
      const bad: [string, unknown][] = [
        ["no traces", { source: src(), traces: [] }],
        ["too many", { source: src(), traces: Array.from({ length: MAX_TRACES_PER_REQUEST + 1 }, () => WITH_TOOLS) }],
        ["no source", { traces: [WITH_TOOLS] }],
        ["hybrid cohort", { source: src({ cohort: "hybrid" }), traces: [WITH_TOOLS] }],
        ["upper-case cohort", { source: src({ cohort: "Dentex" }), traces: [WITH_TOOLS] }],
        ["cohort with a space", { source: src({ cohort: "a b" }), traces: [WITH_TOOLS] }],
        ["bad mode", { source: src({ mode: "tools" }), traces: [WITH_TOOLS] }],
        ["bad backend", { source: src({ backend: "peft" }), traces: [WITH_TOOLS] }],
        ["bad stage", { source: src({ stage: "zero_shot" }), traces: [WITH_TOOLS] }],
        ["trace without ground_truth", { source: src(), traces: [noGt] }],
        ["trace image_id is a string", { source: src(), traces: [{ ...WITH_TOOLS, image_id: "1" }] }],
      ];
      for (const [label, body] of bad) {
        const res = await call({ token: tokA, body });
        expect(res.status, label).toBe(422);
        expect(((await res.json()) as { code: string }).code, label).toBe("validation_failed");
      }
      expect((await store.scoped(a.org.id).listTraces()).length).toBe(before);
    });

    it("inserts a batch, and replaying it is `existing`/sameContent — with per-item results", async () => {
      const body = { source: src({ cohort: "batch_one", sourceFile: "run-42" }), traces: [WITH_TOOLS, HEALTHY] };
      const first = await ok(body);
      expect(first).toMatchObject({ inserted: 2, existing: 0, rejected: 0 });
      expect(first.results.map((r) => [r.index, r.imageId, r.outcome])).toEqual([[0, 1, "inserted"], [1, 3, "inserted"]]);
      const stored = (await store.scoped(a.org.id).listTraces()).filter((t) => t.cohort === "batch_one");
      expect(stored.map((t) => t.sourceFile)).toEqual(["run-42", "run-42"]);

      const replay = await ok(body);
      expect(replay).toMatchObject({ inserted: 0, existing: 2, rejected: 0 });
      expect(replay.results.map((r) => [r.outcome, r.sameContent, r.traceId])).toEqual(first.results.map((r) => ["existing", true, r.traceId]));
    });

    it("GET /images/{id} also returns the identity and ground truth a live run needs (ADR-0025)", async () => {
      const r = store.scoped(a.org.id);
      const images = await r.listImages(a.dentex.id);
      const known = images.find((i) => i.sourceImageId === 1)!;
      const unknown = images.find((i) => i.sourceImageId === 2)!;
      const get = (id: string) =>
        W.imageUrl(
          new Request(`http://test.local/api/worker/v1/images/${id}`, {
            method: "GET",
            headers: { authorization: `Bearer ${readTok}`, "x-contract-version": "1" },
          }),
          deps,
          id,
        );
      const res = await get(known.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        imageId: known.id,
        sourceImageId: 1,
        datasetId: a.dentex.id,
        dataset: "dentex",
        split: null,
        width: 100,
        height: 50,
      });
      expect(Array.isArray(body.groundTruth)).toBe(true);
      expect((body.groundTruth as unknown[]).length).toBeGreaterThan(0);

      // No trace for image 2 yet: unknown truth is `null`, never an invented healthy scan.
      const bare = (await (await get(unknown.id)).json()) as Record<string, unknown>;
      expect(bare.groundTruth).toBeNull();
    });

    it("a live run's backend and stage travel with the batch and are stored on each trace", async () => {
      const res = await ok({
        source: src({ cohort: "live_http", backend: "openai_compat", stage: "test", sourceFile: "agent.run:openai_compat:test" }),
        traces: [WITH_TOOLS],
      });
      const trace = (await store.scoped(a.org.id).listTraces()).find((t) => t.id === res.results[0]!.traceId)!;
      expect(trace).toMatchObject({ backend: "openai_compat", stage: "test", sourceFile: "agent.run:openai_compat:test", verified: true });
      const research = await store.scoped(a.org.id).listTraces({ researchOnly: true });
      expect(research.some((t) => t.id === trace.id)).toBe(false);
    });

    it("the hash ignores messages, image_path and key order: a re-send in another shape is still the same content", async () => {
      await ok({ source: src({ cohort: "shape" }), traces: [WITH_TOOLS] });
      const { messages: _m, image_path: _p, ...bare } = WITH_TOOLS;
      void _m;
      void _p;
      const shuffled = Object.fromEntries(Object.entries(bare).reverse());
      const again = await ok({ source: src({ cohort: "shape" }), traces: [shuffled] });
      expect(again.results[0]).toMatchObject({ outcome: "existing", sameContent: true });
    });

    it("same identity with changed content is reported (`sameContent: false`) and the first import is kept", async () => {
      await ok({ source: src({ cohort: "changed" }), traces: [HEALTHY] });
      const res = await ok({ source: src({ cohort: "changed" }), traces: [{ ...HEALTHY, final_answer: [] , format_ok: false }] });
      expect(res.results[0]).toMatchObject({ outcome: "existing", sameContent: false });
      const kept = (await store.scoped(a.org.id).listTraces()).find((t) => t.cohort === "changed")!;
      expect(kept.formatOk).toBe(true);
    });

    it("per-item outcomes: bad items are rejected without blocking the good ones", async () => {
      const res = await ok({
        source: src({ cohort: "mixed" }),
        traces: [
          { ...WITH_TOOLS, image_id: 999 }, //                        no such image
          TUFTS, //                                                   dataset exists for A (tufts image 1)
          { ...HEALTHY, turns: [HEALTHY.turns[0], HEALTHY.turns[0]] }, // repeated turn number
          { ...HEALTHY, dataset: "upload" }, //                       dataset kind A does not have
          NO_TOOLS,
        ],
      });
      expect(res.results.map((r) => [r.index, r.outcome, r.reason ?? null])).toEqual([
        [0, "rejected", "unknown_image"],
        [1, "inserted", null],
        [2, "rejected", "invalid_trace"],
        [3, "rejected", "unknown_dataset"],
        [4, "inserted", null],
      ]);
      expect(res).toMatchObject({ inserted: 2, existing: 0, rejected: 3 });
    });

    it("an org without the dataset gets `unknown_dataset` (datasets are never created implicitly)", async () => {
      const res = await ok({ source: src({ cohort: "nt" }), traces: [TUFTS, WITH_TOOLS] }, tokNoTufts);
      expect(res.results.map((r) => [r.outcome, r.reason ?? null])).toEqual([["rejected", "unknown_dataset"], ["inserted", null]]);
      expect((await store.scoped(noTufts.org.id).listDatasets()).map((d) => d.source)).toEqual(["dentex"]);
    });

    it("tenants are isolated: B's batch lands in B's dataset only, same identity, separate trace", async () => {
      const mine = await ok({ source: src({ cohort: "iso" }), traces: [WITH_TOOLS] }, tokA);
      const theirs = await ok({ source: src({ cohort: "iso" }), traces: [WITH_TOOLS] }, tokB);
      expect(theirs.results[0]!.outcome).toBe("inserted"); // not `existing`: A's row is invisible to B
      expect(theirs.results[0]!.traceId).not.toBe(mine.results[0]!.traceId);
      expect(await store.scoped(b.org.id).listTraceTurns(mine.results[0]!.traceId!)).toEqual([]);
    });

    it("the generated contract documents ingest/traces as implemented", async () => {
      const { buildWorkerOpenApi } = await import("@/shared/contracts/openapi");
      const paths = buildWorkerOpenApi().paths as Record<string, { post: Record<string, unknown> }>;
      expect(paths["/ingest/traces"]!.post["x-implemented"]).not.toBe(false);
    });
  });
});
