/**
 * WP3 worker read endpoints (ADR-0025 addendum §2): `GET /images` and `GET /traces/{id}`.
 *
 * Both exist only so a worker can do its job — `eval.run` enumerates a split, `trace.render_artifacts`
 * re-executes a stored trace — so the tests pin the two things that matter: the page is stable and
 * org-scoped, and a foreign trace is indistinguishable from a missing one.
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
import { ImageListResponse, WorkerTraceResponse } from "@/shared/contracts/worker";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-worker-reads] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function req(path: string, token: string): Request {
  return new Request(`http://test.local/api/worker/v1${path}`, {
    method: "GET",
    headers: { "x-contract-version": "1", authorization: `Bearer ${token}` },
  });
}

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("worker read endpoints — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;

  d("images and traces", () => {
    let store: OrgStore;
    let org: OrgRecord;
    let other: OrgRecord;
    let token: string;
    let otherToken: string;
    let datasetId: string;
    let otherDatasetId: string;
    const storage = new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-reads-")));
    const deps = () => ({ store, storage, sleep: async () => {} });

    const image = (sourceImageId: number, split: string | null) => ({
      contentHash: `h${sourceImageId}`,
      width: 100,
      height: 80,
      storageKey: `org/img-${sourceImageId}-${suffix}.png`,
      sourceImageId,
      split,
    });

    beforeAll(async () => {
      store = make();
      org = await store.createOrg({ slug: `m8r-a-${suffix}`, name: "A" });
      other = await store.createOrg({ slug: `m8r-b-${suffix}`, name: "B" });
      datasetId = (await store.scoped(org.id).createDataset({ name: "DENTEX", source: "dentex", licenseNote: undefined })).id;
      otherDatasetId = (await store.scoped(other.id).createDataset({ name: "DENTEX", source: "dentex", licenseNote: undefined })).id;
      const minted = mintWorkerToken();
      token = minted.token;
      await store.scoped(org.id).createWorkerToken({ name: "reads", tokenHash: minted.tokenHash, scopes: "jobs:read" });
      const mintedOther = mintWorkerToken();
      otherToken = mintedOther.token;
      await store.scoped(other.id).createWorkerToken({ name: "reads", tokenHash: mintedOther.tokenHash, scopes: "jobs:read" });
    });

    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().delete(organizations).where(inArray(organizations.id, [org.id, other.id]));
      }
    });

    it("pages a dataset by sourceImageId and reports the unpaged total", async () => {
      const r = store.scoped(org.id);
      for (const [n, split] of [[44, "val"], [18, "val"], [32, "test"], [7, null]] as const) {
        await r.createImage({ datasetId, ...image(n, split) });
      }

      const page = await W.listImages(req(`/images?datasetId=${datasetId}&limit=2&offset=0`, token), deps());
      expect(page.status).toBe(200);
      const first = ImageListResponse.parse(await page.json());
      expect(first.images.map((i) => i.sourceImageId)).toEqual([7, 18]);
      expect(first.total).toBe(4);

      const second = await W.listImages(req(`/images?datasetId=${datasetId}&limit=2&offset=2`, token), deps());
      expect(ImageListResponse.parse(await second.json()).images.map((i) => i.sourceImageId)).toEqual([32, 44]);
    });

    it("filters by split; an empty split selects the rows with no split", async () => {
      const val = await W.listImages(req(`/images?datasetId=${datasetId}&split=val`, token), deps());
      expect(ImageListResponse.parse(await val.json()).images.map((i) => i.sourceImageId)).toEqual([18, 44]);

      const none = await W.listImages(req(`/images?datasetId=${datasetId}&split=`, token), deps());
      expect(ImageListResponse.parse(await none.json()).images.map((i) => i.sourceImageId)).toEqual([7]);
    });

    it("rejects a bad dataset id, bad paging and another org's dataset", async () => {
      expect((await W.listImages(req("/images?datasetId=nope", token), deps())).status).toBe(422);
      expect((await W.listImages(req(`/images?datasetId=${datasetId}&limit=0`, token), deps())).status).toBe(422);
      expect((await W.listImages(req(`/images?datasetId=${datasetId}&offset=-1`, token), deps())).status).toBe(422);
      await store.scoped(other.id).createImage({ datasetId: otherDatasetId, ...image(1, "val") });
      expect((await W.listImages(req(`/images?datasetId=${otherDatasetId}`, token), deps())).status).toBe(404);
      // …and it is not a broken filter: the owning org's token reads it.
      const theirs = await W.listImages(req(`/images?datasetId=${otherDatasetId}`, otherToken), deps());
      expect(ImageListResponse.parse(await theirs.json()).total).toBe(1);
    });

    it("returns only the tool calls re-execution needs, in order", async () => {
      const r = store.scoped(org.id);
      const img = (await r.listImages(datasetId)).find((i) => i.sourceImageId === 18)!;
      const ingested = await r.ingestTrace({
        datasetId,
        sourceImageId: 18,
        cohort: "qwen",
        mode: "with_tools",
        verified: true,
        sourceFile: "test",
        contentHash: `c-${suffix}`,
        nTurns: 1,
        nToolCalls: 2,
        formatOk: true,
        verifierReason: null,
        groundTruth: [{ quadrant: 1, tooth_position: 6, diagnosis: "Caries" }],
        finalAnswer: [],
        turns: [
          {
            idx: 0,
            status: "final",
            thought: "not sent to workers",
            rawOutput: "also not sent",
            parsed: { final_answer: [] },
            toolCalls: [
              { idx: 1, toolName: "zoom_crop", args: { bbox: [1, 2, 3, 4] }, ok: true, error: null, trueBbox: null, perturbTier: null },
              { idx: 0, toolName: "window_level", args: { preset: "bone" }, ok: false, error: "boom", trueBbox: null, perturbTier: null },
            ],
          },
        ],
      });
      if (ingested.outcome === "rejected") throw new Error(ingested.reason);

      const res = await W.getWorkerTrace(req(`/traces/${ingested.trace.id}`, token), deps(), ingested.trace.id);
      expect(res.status).toBe(200);
      const body = WorkerTraceResponse.parse(await res.json());
      expect(body.imageId).toBe(img.id);
      expect(body.turns[0]!.toolCalls.map((c) => [c.idx, c.toolName, c.ok])).toEqual([
        [0, "window_level", false],
        [1, "zoom_crop", true],
      ]);
      expect(body.turns[0]!.toolCalls[0]!.args).toEqual({ preset: "bone" });
      expect(JSON.stringify(body)).not.toContain("not sent");
    });

    it("404s an unknown trace, a foreign trace and a malformed id — identical bodies", async () => {
      const r = store.scoped(other.id);
      const oImg = (await r.listImages(otherDatasetId))[0]!;
      const foreign = await r.ingestTrace({
        datasetId: otherDatasetId,
        sourceImageId: oImg.sourceImageId,
        cohort: "qwen",
        mode: "no_tools",
        verified: true,
        sourceFile: "test",
        contentHash: `foreign-${suffix}`,
        nTurns: 0,
        nToolCalls: 0,
        formatOk: true,
        verifierReason: null,
        groundTruth: [],
        finalAnswer: [],
        turns: [],
      });
      if (foreign.outcome === "rejected") throw new Error(foreign.reason);

      const unknown = await W.getWorkerTrace(req("/traces/00000000-0000-4000-8000-000000000000", token), deps(), "00000000-0000-4000-8000-000000000000");
      const theirs = await W.getWorkerTrace(req(`/traces/${foreign.trace.id}`, token), deps(), foreign.trace.id);
      const malformed = await W.getWorkerTrace(req("/traces/not-a-uuid", token), deps(), "not-a-uuid");
      expect([unknown.status, theirs.status, malformed.status]).toEqual([404, 404, 404]);
      const bodies = await Promise.all([unknown, theirs, malformed].map((res) => res.json()));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
    });

    it("the endpoints are contract-documented (they are not private helpers)", async () => {
      const doc = (await import("@/shared/contracts/openapi")).buildWorkerOpenApi() as {
        paths: Record<string, unknown>;
        components: { schemas: Record<string, unknown> };
      };
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/images", "/traces/{id}"]));
      expect(doc.components.schemas).toHaveProperty("ImageListResponse");
      expect(doc.components.schemas).toHaveProperty("WorkerTraceResponse");
    });
  });
});
