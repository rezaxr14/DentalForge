/**
 * M9 slice 2 (ADR-0019): the /api/labels handlers, driven through real Request/Response objects against both stores.
 * The routes themselves are one-line wrappers (session → deps → handler), same as /api/jobs.
 */
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgStore } from "@/shared/db/repos";
import type { Command } from "@/shared/domain/editing/history";
import { predictionsToAnnotations } from "@/shared/domain/annotation";
import { diffToCommands, history as H, mirrorAnnotation } from "@/shared/domain/editing";
import type { Role } from "@/shared/domain/auth";
import type { Actor } from "@/shared/jobs/user-handlers";
import { SetDtoSchema } from "@/shared/labels/dto";
import * as h from "@/shared/labels/handlers";
import { box } from "./helpers/annotation-repo-suite";

const sel = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/shared/db", async (orig) => ({
  ...(await orig<typeof import("@/shared/db")>()),
  selectOrgStore: async () => sel.store,
}));

const pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
let dbUp = false;
try {
  await pool.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await pool.end();
if (!dbUp && process.env.CI) {
  throw new Error("[m9-label-handlers] CI requires Postgres: the SQL half of this suite must run, not skip.");
}

const URL_ = (p: string) => `http://localhost/api/labels/${p}`;
const post = (path: string, body: unknown, raw?: string) =>
  new Request(URL_(path), { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
const create = (annotation: ReturnType<typeof box>, index: number): Command => ({ type: "create", annotation, index });
const body = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n = 0;
const unique = Date.now().toString(36);

function define(label: string, makeStore: () => Promise<OrgStore>, skip = false): void {
  describe.skipIf(skip)(`label handlers: ${label}`, () => {
    async function world() {
      const store = await makeStore();
      const orgA = (await store.createOrg({ slug: `h-a-${unique}-${++n}`, name: "a" })).id;
      const orgB = (await store.createOrg({ slug: `h-b-${unique}-${++n}`, name: "b" })).id;
      const as = (userId: string, orgId: string, role: Role = "annotator"): h.LabelDeps => ({ store, actor: { userId, orgId, role } as Actor });
      return { store, orgA, orgB, as };
    }

    it("answers 401 problem+json to every endpoint when signed out", async () => {
      const { store } = await world();
      const d: h.LabelDeps = { store, actor: null };
      const rs = [
        await h.getSet(d, "1"),
        await h.openSet(d, "1"),
        await h.postOps(post("1/ops", { baseVersion: 1, ops: [] }), d, "1"),
        await h.postTransition(post("1/transition", { transition: "submit", baseVersion: 1 }), d, "1"),
      ];
      for (const r of rs) {
        expect(r.status).toBe(401);
        expect(r.headers.get("content-type")).toBe("application/problem+json");
      }
    });

    it("answers 404 for images that are not fixtures, before reading any body", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      for (const id of ["999", "1.json", "..%2Fsecret", "", "a b"]) {
        expect((await h.getSet(d, id)).status, id).toBe(404);
        expect((await h.openSet(d, id)).status, id).toBe(404);
        expect((await h.postOps(post("x/ops", null, "not json"), d, id)).status, id).toBe(404);
      }
    });

    it("reads 404 until opened; open is idempotent; the DTO carries no internal ids", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      const miss = await h.getSet(d, "1");
      expect(miss.status).toBe(404);
      expect((await body(miss)).code).toBe("not_found");

      const first = await h.openSet(d, "1");
      expect(first.status).toBe(200);
      const dto = await body(first);
      expect(dto).toMatchObject({ version: 1, state: "draft", assigneeId: "alice", submittedAt: null, image: { width: 2744, height: 1316 }, annotations: [] });
      expect(JSON.stringify(dto)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|orgId|org_id/);
      const again = await h.openSet(as("bob", orgA), "1");
      expect((await body(again)).assigneeId).toBe("alice");
      expect(await body(await h.getSet(d, "1"))).toEqual(dto);
    });

    it("labelStatus always answers 200: available for a member, signed-out without a session, unavailable when the store cannot be used", async () => {
      const { store, orgA, as } = await world();
      const say = async (d: Parameters<typeof h.labelStatus>[0]) => {
        const res = h.labelStatus(d);
        expect(res.status).toBe(200);
        return res.json();
      };
      expect(await say(as("alice", orgA, "annotator"))).toEqual({ available: true, reason: null });
      expect(await say({ store, actor: null })).toEqual({ available: false, reason: "signed-out" });
      expect(await say(new Response("x", { status: 503 }))).toEqual({ available: false, reason: "unavailable" });
    });

    it("tells the editor who is asking: viewer is the caller's own id and role on every endpoint, never the assignee's (ADR-0020)", async () => {
      const { orgA, as } = await world();
      const opened = await body(await h.openSet(as("alice", orgA, "annotator"), "1"));
      expect(opened.viewer).toEqual({ userId: "alice", role: "annotator" });
      expect(() => SetDtoSchema.strict().parse(opened)).not.toThrow(); // the client's schema and the server's output cannot drift
      // somebody else reading the same set sees THEIR identity while the assignee stays alice
      const read = await body(await h.getSet(as("rita", orgA, "reviewer"), "1"));
      expect(read.viewer).toEqual({ userId: "rita", role: "reviewer" });
      expect(read.assigneeId).toBe("alice");
      const admin = as("root", orgA, "admin");
      const written = await body(await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("n1", { author_id: "root" }), 0)] }), admin, "1"));
      expect(written.viewer).toEqual({ userId: "root", role: "admin" });
      const stale = await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("n2", { author_id: "root" }), 1)] }), admin, "1");
      expect(stale.status).toBe(409);
      expect((await body(stale)).set.viewer).toEqual({ userId: "root", role: "admin" });
      expect(() => SetDtoSchema.strict().parse(written)).not.toThrow();
      const submitted = await body(await h.postTransition(post("1/transition", { transition: "submit", baseVersion: 2 }), admin, "1"));
      expect(submitted.viewer).toEqual({ userId: "root", role: "admin" });
      expect(Object.keys(submitted.viewer).sort()).toEqual(["role", "userId"]);
    });

    it("accepts what the editor's own diff produces for a realistic session, end to end through the handler (ADR-0020)", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      let set = await body(await h.openSet(d, "1"));
      let hist = H.createHistory([]);
      const flush = async (): Promise<void> => {
        const pending = diffToCommands(set.annotations, hist.present);
        expect(pending.length).toBeGreaterThan(0);
        const res = await h.postOps(post("1/ops", { baseVersion: set.version, ops: pending }), d, "1");
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
        set = await body(res);
        expect(set.annotations.map((a: { id: string }) => a.id)).toEqual(hist.present.map((a) => a.id));
        expect(diffToCommands(set.annotations, hist.present)).toEqual([]); // acknowledged: nothing left to send
      };
      const mine = (id: string, bbox: [number, number, number, number]) => box(id, { bbox, author_id: "alice" });
      // draw three (one dragged onto the right edge, which the editor clamps in float64), label one, drag one
      hist = H.create(hist, mine("ann_1_0", [100.123456789, 200.987654321, 50.5555555, 60.4444444]));
      hist = H.create(hist, mine("ann_1_1", [2437.26490489207, 100.5, 306.7350951079302, 80.25]));
      hist = H.create(hist, mine("ann_1_2", [900, 300, 120, 140]));
      hist = H.update(hist, "ann_1_0", { fdi_quadrant: 4, fdi_position: 6 });
      hist = H.update(hist, "ann_1_2", { bbox: [910, 305, 120, 140] }, { coalesceKey: "g1" });
      hist = H.update(hist, "ann_1_2", { bbox: [930, 320, 120, 140] }, { coalesceKey: "g1" });
      await flush();
      expect(set.version).toBe(2);
      // mirror, delete, undo the delete (re-insertion), relabel: a second batch
      const m = mirrorAnnotation(hist.present[0]!, { width: 2744, height: 1316 }, { id: "ann_2_3", authorId: "alice" });
      hist = H.create(hist, m!);
      hist = H.remove(hist, "ann_1_2");
      hist = H.undo(hist);
      hist = H.update(hist, "ann_1_1", { pathology: "Impacted" });
      await flush();
      expect(set.version).toBe(3);
      hist = H.remove(hist, "ann_1_0");
      await flush();
      expect(set.annotations.map((a: { id: string }) => a.id)).toEqual(["ann_1_1", "ann_1_2", "ann_2_3"]);
    });

    it("imports pre-labels through the server when they are authored by the viewer, and refuses the default model author (ADR-0020)", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      const open = await body(await h.openSet(d, "1"));
      const preds = [
        { bbox: [10, 20, 300, 400], fdi_quadrant: 2, fdi_position: 7, confidence: 0.9 },
        { bbox: [600, 20, 100, 100], fdi_quadrant: 1, fdi_position: 1, confidence: 0.4 },
      ];
      const target = { imageId: "1", width: 2744, height: 1316, modelId: "yolo_cv_best", startIdx: 0 };
      const sendImport = async (authorId?: string) => {
        const hist = H.createMany(H.createHistory([]), predictionsToAnnotations(preds, { ...target, ...(authorId ? { authorId } : {}) }), "Import pre-labels");
        return h.postOps(post("1/ops", { baseVersion: open.version, ops: diffToCommands([], hist.present) }), d, "1");
      };
      const refused = await sendImport(); // author_id "yolo:yolo_cv_best": the old shape
      expect(refused.status).toBe(422);
      expect((await body(await h.getSet(d, "1"))).version).toBe(1); // nothing written
      const ok = await sendImport("alice");
      expect(ok.status).toBe(200);
      const set = await body(ok);
      expect(set.annotations).toHaveLength(2);
      expect(set.annotations.map((a: Record<string, unknown>) => [a.author_id, a.source, a.model_id, a.confidence])).toEqual([
        ["alice", "model", "yolo_cv_best", 0.9],
        ["alice", "model", "yolo_cv_best", 0.4],
      ]);
    });

    it("applies ops, returns the new set, and answers 409 with the current set for a stale baseVersion", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      await h.openSet(d, "1");
      const ok = await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("new_1"), 0)] }), d, "1");
      expect(ok.status).toBe(200);
      const set = await body(ok);
      expect(set.version).toBe(2);
      expect(set.annotations.map((a: { id: string }) => a.id)).toEqual(["new_1"]);

      const stale = await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("new_2"), 1)] }), d, "1");
      expect(stale.status).toBe(409);
      expect(stale.headers.get("content-type")).toBe("application/problem+json");
      const p = await body(stale);
      expect(p).toMatchObject({ code: "conflict", reason: "version" });
      expect(p.set).toEqual(set);
      // the rebase the client performs: resend on the returned version
      const rebased = await h.postOps(post("1/ops", { baseVersion: p.set.version, ops: [create(box("new_2"), 1)] }), d, "1");
      expect(rebased.status).toBe(200);
      expect((await body(rebased)).annotations).toHaveLength(2);
    });

    it("rejects malformed, oversized and schema-invalid requests without touching the set", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      await h.openSet(d, "1");
      const bad = async (r: Request, status: number, what: string) => expect((await h.postOps(r, d, "1")).status, what).toBe(status);
      await bad(post("1/ops", null, "{nope"), 400, "malformed JSON");
      await bad(post("1/ops", null, JSON.stringify({ baseVersion: 1, ops: [], pad: "x".repeat(300_000) })), 413, "oversized body");
      await bad(new Request(URL_("1/ops"), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ baseVersion: 1, ops: [] }) }), 415, "text/plain body");
      await bad(new Request(URL_("1/ops"), { method: "POST", body: JSON.stringify({ baseVersion: 1, ops: [] }) }), 415, "no content-type");
      await bad(post("1/ops", { baseVersion: 0, ops: [] }), 422, "baseVersion 0");
      await bad(post("1/ops", { baseVersion: 1, ops: [], extra: true }), 422, "unknown top-level key");
      await bad(post("1/ops", { baseVersion: 1 }), 422, "missing ops");
      await bad(post("1/ops", { baseVersion: 1, ops: Array.from({ length: 201 }, (_, i) => create(box(`b${i}`), i)) }), 422, "201 ops");
      await bad(post("1/ops", { baseVersion: 1, ops: [{ type: "update", id: "x", before: {}, after: { status: "approved" } }] }), 422, "status in a patch");
      await bad(post("1/ops", { baseVersion: 1, ops: [{ type: "update", id: "x", before: {}, after: { author_id: "eve" } }] }), 422, "author in a patch");
      await bad(post("1/ops", { baseVersion: 1, ops: [{ type: "update", id: "x", before: {}, after: { model_id: "yolo" } }] }), 422, "model id in a patch");
      await bad(post("1/ops", { baseVersion: 1, ops: [create(box("long", { source: "model", confidence: 0.5, model_id: "x".repeat(201) }), 0)] }), 422, "201-character model id");
      await bad(post("1/ops", { baseVersion: 1, ops: [{ type: "explode" }] }), 422, "unknown command");
      let deep: Command = create(box("deep"), 0);
      for (let i = 0; i < 6; i++) deep = { type: "batch", label: "x", commands: [deep] };
      await bad(post("1/ops", { baseVersion: 1, ops: [deep] }), 422, "nesting");
      await bad(post("1/ops", { baseVersion: 1, ops: [create(box("spoof", { author_id: "eve" }), 0)] }), 422, "spoofed author");
      await bad(post("1/ops", { baseVersion: 1, ops: [create(box("out", { bbox: [2700, 10, 100, 10] }), 0)] }), 422, "human box outside the image");
      expect((await body(await h.getSet(d, "1"))).version).toBe(1);
    });

    it("answers 404 to ops and transitions on an image nobody opened", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      expect((await h.postOps(post("1/ops", { baseVersion: 1, ops: [] }), d, "1")).status).toBe(404);
      expect((await h.postTransition(post("1/transition", { transition: "submit", baseVersion: 1 }), d, "1")).status).toBe(404);
    });

    it("walks submit → approve with the review rules, and refuses edits afterwards", async () => {
      const { store, orgA, as } = await world();
      const alice = as("alice", orgA, "annotator");
      await h.openSet(alice, "1");
      await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("a"), 0)] }), alice, "1");
      const tr = (d: h.LabelDeps, transition: string, baseVersion: number, extra: object = {}) =>
        h.postTransition(post("1/transition", { transition, baseVersion, ...extra }), d, "1");

      expect((await tr(alice, "approve", 2)).status).toBe(403); // an annotator never decides
      const submitted = await tr(alice, "submit", 2);
      expect(submitted.status).toBe(200);
      expect(await body(submitted)).toMatchObject({ state: "submitted", version: 3 });
      expect((await h.postOps(post("1/ops", { baseVersion: 3, ops: [create(box("late"), 1)] }), alice, "1")).status).toBe(409);

      expect((await tr(as("alice", orgA, "admin"), "approve", 3)).status).toBe(403); // the author, even as admin
      expect((await tr(as("erin", orgA, "annotator"), "approve", 3)).status).toBe(403); // not the author, but not a reviewer either
      expect((await tr(as("erin", orgA, "annotator"), "reject", 3)).status).toBe(403);
      expect((await tr(as("carol", orgA, "reviewer"), "approve", 2)).status).toBe(409); // stale version
      expect((await tr(as("carol", orgA, "reviewer"), "explode", 3)).status).toBe(422);
      expect((await tr(as("carol", orgA, "reviewer"), "approve", 3, { foo: 1 })).status).toBe(422); // unknown key
      expect((await tr(as("carol", orgA, "reviewer"), "reject", 3, { reason: "x".repeat(2001) })).status).toBe(422);
      const done = await tr(as("carol", orgA, "reviewer"), "approve", 3, { reason: "looks right" });
      expect(done.status).toBe(200);
      expect(await body(done)).toMatchObject({ state: "approved", version: 4 });
      const audit = (await store.scoped(orgA).listAudit()).filter((r) => r.action === "annotation_set.approve");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: "carol", meta: { reason: "looks right", version: 4 } });
      const late = await h.postOps(post("1/ops", { baseVersion: 4, ops: [create(box("later"), 1)] }), alice, "1");
      expect(late.status).toBe(409);
      expect(await body(late)).toMatchObject({ reason: "state" });
    });

    it("never shows one organisation's set to another, and each org writes its own rows for the same image and box id", async () => {
      const { orgA, orgB, as } = await world();
      const a = as("alice", orgA);
      const b = as("bea", orgB);
      await h.openSet(a, "1");
      await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("pred_1_3", { author_id: "alice" }), 0)] }), a, "1");
      expect((await h.getSet(b, "1")).status).toBe(404); // B never opened it
      await h.openSet(b, "1");
      expect((await body(await h.getSet(b, "1"))).annotations).toEqual([]);
      const wb = await h.postOps(post("1/ops", { baseVersion: 1, ops: [create(box("pred_1_3", { author_id: "bea", bbox: [5, 5, 10, 10] }), 0)] }), b, "1");
      expect(wb.status).toBe(200);
      const sa = await body(await h.getSet(a, "1"));
      const sb = await body(await h.getSet(b, "1"));
      expect(sa.annotations[0]).toMatchObject({ author_id: "alice", bbox: [100, 100, 50, 60] });
      expect(sb.annotations[0]).toMatchObject({ author_id: "bea", bbox: [5, 5, 10, 10] });
      expect([sa.version, sb.version]).toEqual([2, 2]);
    });

    it("maps a fixture to the image an import created, by the number in its file name", async () => {
      const { store, orgA, as } = await world();
      const repo = store.scoped(orgA);
      const ds = await repo.createDataset({ name: "dentex-import", source: "dentex" });
      await repo.createImage({ datasetId: ds.id, sourceImageId: 283, contentHash: "h", width: 111, height: 222, storageKey: "k", split: "train" });
      // fixture "2" is train_283.png: it must resolve to the imported row, not register a second image
      const dto = await body(await h.openSet(as("alice", orgA), "2"));
      expect(dto.image).toEqual({ width: 111, height: 222 });
      expect(await repo.listDatasets()).toHaveLength(1);
      expect(await repo.listImages(ds.id)).toHaveLength(1);
    });

    it("labels two different images independently", async () => {
      const { orgA, as } = await world();
      const d = as("alice", orgA);
      await h.openSet(d, "1");
      await h.openSet(d, "2");
      expect((await body(await h.getSet(d, "2"))).image).toEqual({ width: 2872, height: 1504 });
      await h.postOps(post("2/ops", { baseVersion: 1, ops: [create(box("new_1"), 0)] }), d, "2");
      expect((await body(await h.getSet(d, "1"))).annotations).toEqual([]);
      expect((await body(await h.getSet(d, "2"))).annotations).toHaveLength(1);
    });
  });
}

define("memory", async () => new MemoryStore());
define("drizzle", async () => new DrizzleOrgStore(getPgDb()), !dbUp);

describe("resolveLabelDeps", () => {
  it("answers 503 + Retry-After on the in-memory fallback instead of pretending to save", async () => {
    sel.store = new MemoryStore(); // carries the degraded brand
    const { resolveLabelDeps } = await import("@/shared/labels/deps");
    const r = await resolveLabelDeps();
    expect(r).toBeInstanceOf(Response);
    const res = r as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  it("answers 503 when the selector throws", async () => {
    sel.store = null;
    vi.doMock("@/shared/db", async (orig) => ({ ...(await orig<typeof import("@/shared/db")>()), selectOrgStore: async () => { throw new Error("db down"); } }));
    vi.resetModules();
    const { resolveLabelDeps } = await import("@/shared/labels/deps");
    const res = (await resolveLabelDeps()) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("15");
    vi.doUnmock("@/shared/db");
  });
});
