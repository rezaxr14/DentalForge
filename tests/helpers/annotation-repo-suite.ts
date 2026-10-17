/**
 * ONE suite for the annotation-set repository (ADR-0019), run against MemoryStore AND DrizzleOrgStore by
 * tests/m9-annotation-repo.test.ts. Every assertion is made against the public `ScopedRepos` surface only, so the two
 * stores cannot pass different tests. Orgs are created per test with unique slugs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Annotation } from "@/shared/contracts/labels";
import { apply, type Command } from "@/shared/domain/editing/history";
import { canonicalAnnotation } from "@/shared/db/annotation-map";
import type { AnnotationSetSnapshot, OpenImageInput, OrgStore, ScopedRepos, TransitionOutcome } from "@/shared/db/repos";

const IMAGE: OpenImageInput = {
  source: "dentex",
  datasetName: "dentex",
  licenseNote: "CC-BY-NC-SA 4.0",
  sourceImageId: 673,
  contentHash: "sha256:test",
  width: 2744,
  height: 1316,
  storageKey: "fixtures/labels/1.jpg",
  split: null,
};
const KEY = { source: IMAGE.source, sourceImageId: IMAGE.sourceImageId } as const;

export function box(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    bbox: [100, 100, 50, 60],
    fdi_quadrant: 1,
    fdi_position: 6,
    pathology: "Caries",
    source: "human",
    confidence: null,
    status: "draft",
    version: 1,
    author_id: "alice",
    ...over,
  };
}
const create = (annotation: Annotation, index: number): Command => ({ type: "create", annotation, index });

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
const unique = Date.now().toString(36);

export function defineAnnotationRepoSuite(
  label: string,
  makeStore: () => Promise<OrgStore>,
  opts: { skip?: boolean } = {},
): void {
  describe.skipIf(opts.skip ?? false)(`annotation repository: ${label}`, () => {
    async function newOrg(store: OrgStore, tag = "o"): Promise<ScopedRepos> {
      const org = await store.createOrg({ slug: `m9-${tag}-${unique}-${++counter}`, name: tag });
      return store.scoped(org.id);
    }
    async function setup(): Promise<{ store: OrgStore; repo: ScopedRepos; snap: AnnotationSetSnapshot }> {
      const store = await makeStore();
      const repo = await newOrg(store);
      const snap = await repo.openAnnotationSet({ ...IMAGE, assigneeId: "alice" });
      return { store, repo, snap };
    }
    const ops = (repo: ScopedRepos, baseVersion: number, list: Command[], actorId = "alice") =>
      repo.applyAnnotationOps({ ...KEY, baseVersion, ops: list, actorId });
    const ok = (r: TransitionOutcome): AnnotationSetSnapshot => {
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
      return r.snapshot;
    };

    it("opens lazily and idempotently: one dataset, one image, one set, assignee = first opener", async () => {
      const store = await makeStore();
      const repo = await newOrg(store);
      expect(await repo.getAnnotationSet(KEY)).toBeNull(); // reading never creates
      expect(await repo.listDatasets()).toHaveLength(0);

      const first = await repo.openAnnotationSet({ ...IMAGE, assigneeId: "alice" });
      const second = await repo.openAnnotationSet({ ...IMAGE, assigneeId: "bob" });
      expect(second.set.id).toBe(first.set.id);
      expect(second.image.id).toBe(first.image.id);
      expect(second.set.assigneeId).toBe("alice");
      expect(first.set).toMatchObject({ state: "draft", version: 1, submittedAt: null });
      expect(first.annotations).toEqual([]);
      expect(first.image).toMatchObject({ sourceImageId: 673, width: 2744, height: 1316 });
      const datasets = await repo.listDatasets();
      expect(datasets).toHaveLength(1);
      expect(datasets[0]).toMatchObject({ name: "dentex", source: "dentex", licenseNote: "CC-BY-NC-SA 4.0" });
      expect(await repo.getAnnotationSet(KEY)).toEqual(first);
    });

    it("concurrent first opens register exactly one dataset, image and set", async () => {
      const store = await makeStore();
      const repo = await newOrg(store);
      const all = await Promise.all([1, 2, 3, 4].map((i) => repo.openAnnotationSet({ ...IMAGE, assigneeId: `u${i}` })));
      expect(new Set(all.map((s) => s.set.id)).size).toBe(1);
      expect(new Set(all.map((s) => s.image.id)).size).toBe(1);
      expect(await repo.listDatasets()).toHaveLength(1);
    });

    it("reuses a dataset and image an import already created instead of registering a second one", async () => {
      const store = await makeStore();
      const repo = await newOrg(store);
      const ds = await repo.createDataset({ name: "dentex-import", source: "dentex" });
      const img = await repo.createImage({
        datasetId: ds.id, sourceImageId: 673, contentHash: "h", width: 2872, height: 1504, storageKey: "k", split: "train",
      });
      const snap = await repo.openAnnotationSet({ ...IMAGE, assigneeId: "alice" });
      expect(snap.image.id).toBe(img.id);
      expect(snap.image.width).toBe(2872); // the existing row wins, the input is only a registration default
      expect(await repo.listDatasets()).toHaveLength(1);
    });

    it("registers a new image inside the dataset an import already created, not in a second dataset", async () => {
      const store = await makeStore();
      const repo = await newOrg(store);
      const ds = await repo.createDataset({ name: "dentex-import", source: "dentex" });
      await repo.createImage({ datasetId: ds.id, sourceImageId: 1, contentHash: "h", width: 10, height: 10, storageKey: "k", split: null });
      const snap = await repo.openAnnotationSet({ ...IMAGE, assigneeId: "alice" });
      expect(snap.image.datasetId).toBe(ds.id);
      expect(await repo.listDatasets()).toHaveLength(1);
      expect(await repo.listImages(ds.id)).toHaveLength(2);
    });

    it("stores boxes by the editor's ids and order, and bumps the version once per changed batch", async () => {
      const { repo, snap } = await setup();
      const next = ok(await ops(repo, 1, [create(box("pred_1_3"), 0), create(box("new_1", { fdi_position: 7 }), 1), create(box("pred_1_9"), 1)]));
      expect(next.set.version).toBe(2);
      expect(next.annotations.map((a) => a.id)).toEqual(["pred_1_3", "pred_1_9", "new_1"]);
      expect(await repo.getAnnotationSet(KEY)).toEqual(next);
      // internal UUIDs never leak into what the editor sees
      expect(JSON.stringify(next.annotations)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(snap.set.version).toBe(1);
    });

    it("matches the editor's own `apply` over a long random sequence of batches (model-based)", async () => {
      const { repo } = await setup();
      const rng = mulberry32(20261016);
      let expected: Annotation[] = [];
      let version = 1;
      let nextId = 0;
      for (let step = 0; step < 40; step++) {
        const batch: Command[] = [];
        for (let k = 1 + Math.floor(rng() * 4); k > 0; k--) {
          const r = rng();
          let c: Command;
          if (expected.length < 3 || r < 0.55) {
            c = create(box(`new_${nextId++}`, { bbox: [rng() * 2000, rng() * 1000, 20 + rng() * 100, 20 + rng() * 100] }), Math.floor(rng() * (expected.length + 1)));
          } else if (r < 0.75) {
            const a = expected[Math.floor(rng() * expected.length)]!;
            c = { type: "delete", annotation: a, index: expected.indexOf(a) };
          } else {
            const a = expected[Math.floor(rng() * expected.length)]!;
            c = { type: "update", id: a.id, before: {}, after: rng() < 0.5 ? { bbox: [rng() * 2000, rng() * 1000, 30 + rng() * 90, 30 + rng() * 90] } : { pathology: rng() < 0.5 ? "Deep Caries" : "Impacted" } };
          }
          expected = apply(expected, c);
          batch.push(c);
        }
        // every third batch travels as one nested `batch` command, like a mirror or a multi-box edit does
        const sent: Command[] = step % 3 === 0 ? [{ type: "batch", label: "multi", commands: batch }] : batch;
        const snap = ok(await ops(repo, version, sent));
        version = snap.set.version;
        expect(snap.annotations, `after batch ${step}`).toEqual(expected.map(canonicalAnnotation));
      }
      expect(version).toBeGreaterThan(20);
      expect((await repo.getAnnotationSet(KEY))!.annotations).toEqual(expected.map(canonicalAnnotation));
    });

    it("rejects a stale baseVersion with the current set and writes nothing", async () => {
      const { repo } = await setup();
      const v2 = ok(await ops(repo, 1, [create(box("a"), 0)]));
      const stale = await ops(repo, 1, [create(box("b"), 1)]);
      expect(stale).toMatchObject({ kind: "conflict", reason: "version" });
      if (stale.kind === "conflict") expect(stale.snapshot).toEqual(v2);
      expect(await repo.getAnnotationSet(KEY)).toEqual(v2);
    });

    it("lets exactly one of two concurrent batches on the same baseVersion win", async () => {
      const { repo } = await setup();
      const [x, y] = await Promise.all([ops(repo, 1, [create(box("x"), 0)]), ops(repo, 1, [create(box("y"), 0)])]);
      expect([x.kind, y.kind].sort()).toEqual(["conflict", "ok"]);
      const snap = (await repo.getAnnotationSet(KEY))!;
      expect(snap.set.version).toBe(2);
      expect(snap.annotations).toHaveLength(1);
    });

    it("rolls back the whole batch when one op is invalid", async () => {
      const { repo } = await setup();
      const before = ok(await ops(repo, 1, [create(box("keep"), 0)]));
      const bad: Command[] = [
        create(box("good"), 1),
        create(box("spoofed", { author_id: "mallory" }), 2), // authored by someone else
      ];
      expect(await ops(repo, 2, bad)).toMatchObject({ kind: "invalid" });
      expect(await repo.getAnnotationSet(KEY)).toEqual(before);
    });

    it("validates boxes: human boxes stay inside the image, every box has a positive finite size, authorship and status are the caller's", async () => {
      const { repo } = await setup();
      const rejected = async (a: Annotation) => expect(await ops(repo, 1, [create(a, 0)])).toMatchObject({ kind: "invalid" });
      await rejected(box("out_right", { bbox: [2700, 100, 100, 50] }));
      await rejected(box("out_left", { bbox: [-1, 100, 50, 50] }));
      await rejected(box("out_bottom", { bbox: [100, 1300, 50, 50] }));
      await rejected(box("zero_w", { bbox: [100, 100, 0, 50] }));
      await rejected(box("neg_h", { bbox: [100, 100, 50, -5] }));
      await rejected(box("approved", { status: "approved" }));
      // only the finiteness rule can catch these: model boxes are exempt from the inside-the-image rule
      await rejected(box("inf_w", { source: "model", confidence: 0.5, bbox: [1, 1, Number.POSITIVE_INFINITY, 5] }));
      await rejected(box("nan_x", { source: "model", confidence: 0.5, bbox: [Number.NaN, 1, 5, 5] }));
      await rejected(box("zero_model", { source: "model", confidence: 0.5, bbox: [1, 1, 0, 5] }));
      const overhang = box("m1", { source: "model", confidence: 0.5, bbox: [100, 1300, 50, 50] });
      expect(ok(await ops(repo, 1, [create(overhang, 0)])).annotations).toHaveLength(1); // model output is tolerated
      // dragging a human box out of the image is refused as well, not only creating it there
      const drag: Command = { type: "update", id: "h1", before: {}, after: { bbox: [2740, 100, 50, 50] } };
      ok(await ops(repo, 2, [create(box("h1"), 1)]));
      expect(await ops(repo, 3, [drag])).toMatchObject({ kind: "invalid" });
    });

    it("accepts a human box clamped to the image edge although its float32 form overhangs by rounding, and still refuses a visible overhang (ADR-0020)", async () => {
      const { repo } = await setup();
      // float64: x + w === 2744 and y + h === 1316 exactly (what the editor's clamp produces); float32 canonical: 2744.0001 / 1316.00005
      const right = box("edge_r", { bbox: [2437.26490489207, 100.5, 306.7350951079302, 80.25] });
      const bottom = box("edge_b", { bbox: [100, 1111.3666507248845, 50, 204.6333492751155] });
      const snap = ok(await ops(repo, 1, [create(right, 0), create(bottom, 1)]));
      expect(snap.annotations.map((a) => a.id)).toEqual(["edge_r", "edge_b"]);
      expect(snap.annotations[0]!.bbox[0]).toBeCloseTo(2437.265, 3); // stored in its canonical float32 form
      // half a hundredth of a pixel is rounding; five hundredths is a box that really leaves the image
      ok(await ops(repo, 2, [create(box("slack", { bbox: [2693.995, 10, 50, 10] }), 2)]));
      expect(await ops(repo, 3, [create(box("over_r", { bbox: [2694.05, 10, 50, 10] }), 3)])).toMatchObject({ kind: "invalid" });
      expect(await ops(repo, 3, [create(box("over_b", { bbox: [10, 1306.05, 10, 10] }), 3)])).toMatchObject({ kind: "invalid" });
    });

    it("stores a model box's model id and confidence, keeps the key off human boxes, replays as a no-op, and refuses a model id on a human box (ADR-0020)", async () => {
      const { repo } = await setup();
      const m = box("pred_1_0", { source: "model", confidence: 0.87, model_id: "yolo_cv_best" });
      const snap = ok(await ops(repo, 1, [create(m, 0), create(box("h1"), 1)]));
      expect(snap.annotations[0]).toMatchObject({ source: "model", model_id: "yolo_cv_best", confidence: 0.87 });
      expect("model_id" in snap.annotations[1]!).toBe(false);
      const again = ok(await ops(repo, snap.set.version, [create(m, 0)]));
      expect(again.set.version).toBe(snap.set.version); // same box, same model: nothing changed
      expect(await ops(repo, again.set.version, [create(box("bad", { model_id: "yolo_cv_best" }), 2)])).toMatchObject({ kind: "invalid" });
      const reread = await repo.getAnnotationSet(IMAGE);
      expect(reread!.annotations.map((a) => a.model_id)).toEqual(["yolo_cv_best", undefined]);
    });

    it("keeps the real stored model predictions of fixture 1 intact, including the 5 that overhang the image", async () => {
      const { repo } = await setup();
      const fx = JSON.parse(readFileSync(resolve(__dirname, "../../fixtures/labels/1.json"), "utf8")) as {
        width: number; height: number;
        predictions: { bbox: [number, number, number, number]; fdi_quadrant: number; fdi_position: number; confidence: number }[];
      };
      expect(fx.width).toBe(IMAGE.width);
      const overhanging = fx.predictions.filter((p) => p.bbox[1] + p.bbox[3] > fx.height);
      expect(overhanging.length).toBeGreaterThan(0); // the premise: real model output does not fit the strict rule
      const cmds = fx.predictions.map((p, i) =>
        create(box(`pred_1_${i}`, { source: "model", bbox: p.bbox, fdi_quadrant: p.fdi_quadrant, fdi_position: p.fdi_position, confidence: p.confidence, pathology: "Caries" }), i),
      );
      const snap = ok(await ops(repo, 1, cmds));
      expect(snap.annotations).toHaveLength(fx.predictions.length);
      expect(snap.annotations.map((a) => a.bbox)).toEqual(fx.predictions.map((p) => p.bbox.map((n) => canonicalAnnotation(box("x", { bbox: [n, 0, 1, 1] })).bbox[0])));
      expect(snap.annotations.every((a) => a.confidence !== null)).toBe(true); // confidence survives the round trip
    });

    it("enforces the size limits: 200 ops per request, 500 boxes per set", async () => {
      const { repo } = await setup();
      const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => create(box(`b${from + i}`, { bbox: [10 + (i % 50) * 40, 10 + Math.floor(i / 50) * 40, 30, 30] }), from + i));
      expect(await ops(repo, 1, many(0, 201))).toMatchObject({ kind: "invalid" });
      let v = 1;
      for (const [from, n] of [[0, 200], [200, 200], [400, 100]] as const) v = ok(await ops(repo, v, many(from, n))).set.version;
      expect((await repo.getAnnotationSet(KEY))!.annotations).toHaveLength(500);
      expect(await ops(repo, v, [create(box("one_too_many"), 500)])).toMatchObject({ kind: "invalid" });
    });

    it("converges when a batch is replayed: duplicates are no-ops and do not bump the version, even for float32-rounded values", async () => {
      const { repo } = await setup();
      const odd = box("f1", { bbox: [123.456789012, 234.567890123, 45.6789012345, 56.7890123456] });
      const first = ok(await ops(repo, 1, [create(odd, 0)]));
      const replay = ok(await ops(repo, first.set.version, [create(odd, 0)]));
      expect(replay.set.version).toBe(first.set.version);
      const upd: Command = { type: "update", id: "f1", before: {}, after: { bbox: [1.123456789, 2.123456789, 33.123456789, 44.123456789] } };
      const u1 = ok(await ops(repo, first.set.version, [upd]));
      expect(u1.set.version).toBe(first.set.version + 1);
      const u2 = ok(await ops(repo, u1.set.version, [upd]));
      expect(u2.set.version).toBe(u1.set.version);
    });

    it("walks the state machine and refuses edits once the set is no longer a draft", async () => {
      const { repo } = await setup();
      const v = ok(await ops(repo, 1, [create(box("a"), 0)])).set.version;
      const t = (transition: "submit" | "approve" | "reject" | "reopen", over: Record<string, unknown> = {}) =>
        repo.transitionAnnotationSet({ ...KEY, baseVersion: v + 1, transition, actorId: "alice", role: "annotator", reason: "r", ...over });

      expect(await t("approve", { baseVersion: v, actorId: "carol", role: "reviewer" })).toMatchObject({ kind: "conflict", reason: "state" }); // not submitted yet
      const submitted = ok(await t("submit", { baseVersion: v }));
      expect(submitted.set).toMatchObject({ state: "submitted", version: v + 1 });
      expect(submitted.set.submittedAt).toBeInstanceOf(Date);
      expect(submitted.annotations.every((a) => a.status === "submitted")).toBe(true);
      expect(await repo.getAnnotationSet(KEY)).toEqual(submitted); // what the caller was told is what is stored
      expect(await ops(repo, v + 1, [create(box("late"), 1)])).toMatchObject({ kind: "conflict", reason: "state" });

      expect(await t("approve", { baseVersion: v, actorId: "carol", role: "reviewer" })).toMatchObject({ kind: "conflict", reason: "version" });
      const rejected = ok(await t("reject", { actorId: "carol", role: "reviewer", reason: "boxes too loose" }));
      expect(rejected.set.state).toBe("rejected");
      const reopened = ok(await repo.transitionAnnotationSet({ ...KEY, baseVersion: v + 2, transition: "reopen", actorId: "bob", role: "annotator" }));
      expect(reopened.set).toMatchObject({ state: "draft", submittedAt: null, version: v + 3 });
      expect(reopened.annotations.every((a) => a.status === "draft")).toBe(true);
      expect(await repo.getAnnotationSet(KEY)).toEqual(reopened);
      ok(await ops(repo, v + 3, [create(box("again"), 1)]));

      const audit = (await repo.listAudit()).map((r) => r.action);
      expect(audit).toEqual(["annotation_set.submit", "annotation_set.reject", "annotation_set.reopen"]);
    });

    it("never lets someone decide work they contributed to, and only reviewers/admins decide", async () => {
      const { repo } = await setup();
      let v = ok(await ops(repo, 1, [create(box("a", { author_id: "alice" }), 0)])).set.version;
      v = ok(await ops(repo, v, [create(box("d", { author_id: "dave" }), 1)], "dave")).set.version;
      v = ok(await repo.transitionAnnotationSet({ ...KEY, baseVersion: v, transition: "submit", actorId: "alice", role: "annotator" })).set.version;
      const decide = (actorId: string, role: "admin" | "annotator" | "reviewer", transition: "approve" | "reject" = "approve") =>
        repo.transitionAnnotationSet({ ...KEY, baseVersion: v, transition, actorId, role });

      expect(await decide("alice", "admin")).toEqual({ kind: "forbidden" }); // the assignee, even as admin
      expect(await decide("dave", "reviewer")).toEqual({ kind: "forbidden" }); // authored a box
      expect(await decide("erin", "annotator")).toEqual({ kind: "forbidden" }); // wrong role
      expect(await decide("erin", "annotator", "reject")).toEqual({ kind: "forbidden" });
      expect(await decide("dave", "reviewer", "reject")).toEqual({ kind: "forbidden" });
      expect((await repo.getAnnotationSet(KEY))!.set.state).toBe("submitted");
      const done = ok(await decide("carol", "reviewer"));
      expect(done.set.state).toBe("approved");
      expect(done.annotations.every((a) => a.status === "approved")).toBe(true);
    });

    it("does not disturb another image's boxes that share client ids inside the same org", async () => {
      const { repo } = await setup();
      const KEY2 = { source: IMAGE.source, sourceImageId: 283 } as const;
      await repo.openAnnotationSet({ ...IMAGE, sourceImageId: 283, storageKey: "fixtures/labels/2.jpg", assigneeId: "alice" });
      const seed = ["z", "y", "x"].map((id, i) => create(box(id, { bbox: [10 + i * 100, 10, 50, 50] }), i));
      ok(await ops(repo, 1, seed));
      ok(await repo.applyAnnotationOps({ ...KEY2, baseVersion: 1, ops: seed, actorId: "alice" }));
      // image 1: take `z` out and put it back at the end, so y and x move up by one (position-only changes)
      const z = (await repo.getAnnotationSet(KEY))!.annotations[0]!;
      const moved = ok(await ops(repo, 2, [{ type: "delete", annotation: z, index: 0 }, create(z, 2)]));
      expect(moved.annotations.map((a) => a.id)).toEqual(["y", "x", "z"]);
      const other = (await repo.getAnnotationSet(KEY2))!;
      expect(other.annotations.map((a) => a.id)).toEqual(["z", "y", "x"]);
      expect(other.set.version).toBe(2);
    });

    it("counts the assignee as an author even when someone else drew every box", async () => {
      const { repo } = await setup(); // alice opened it, so she is the assignee and draws nothing
      const v = ok(await ops(repo, 1, [create(box("b1", { author_id: "bob" }), 0)], "bob")).set.version;
      const submitted = ok(await repo.transitionAnnotationSet({ ...KEY, baseVersion: v, transition: "submit", actorId: "bob", role: "annotator" }));
      const approve = (actorId: string) =>
        repo.transitionAnnotationSet({ ...KEY, baseVersion: submitted.set.version, transition: "approve", actorId, role: "reviewer" });
      expect(await approve("alice")).toEqual({ kind: "forbidden" });
      expect(await approve("bob")).toEqual({ kind: "forbidden" });
      expect((await approve("carol")).kind).toBe("ok");
    });

    it("refuses absurdly nested batches", async () => {
      const { repo } = await setup();
      let nested: Command = create(box("deep"), 0);
      for (let i = 0; i < 6; i++) nested = { type: "batch", label: `l${i}`, commands: [nested] };
      expect(await ops(repo, 1, [nested])).toMatchObject({ kind: "invalid", message: expect.stringContaining("nested") });
      let shallow: Command = create(box("shallow"), 0);
      for (let i = 0; i < 2; i++) shallow = { type: "batch", label: `l${i}`, commands: [shallow] };
      expect(ok(await ops(repo, 1, [shallow])).annotations).toHaveLength(1);
    });

    it("keeps organisations apart, including when both use the same image key and the same box ids", async () => {
      const store = await makeStore();
      const a = await newOrg(store, "a");
      const b = await newOrg(store, "b");
      const sa = await a.openAnnotationSet({ ...IMAGE, assigneeId: "alice" });
      const sb = await b.openAnnotationSet({ ...IMAGE, assigneeId: "bea" });
      expect(sb.set.id).not.toBe(sa.set.id);
      expect(sb.image.id).not.toBe(sa.image.id);
      // each org registered its OWN dataset: B's image must not hang off A's dataset
      expect(sb.image.datasetId).not.toBe(sa.image.datasetId);
      expect((await a.listDatasets()).map((d) => d.id)).toEqual([sa.image.datasetId]);
      expect((await b.listDatasets()).map((d) => d.id)).toEqual([sb.image.datasetId]);

      // the replay case: the SAME key and the SAME client id in both orgs; each org's next write lands on its own row
      const same = [create(box("pred_1_3", { author_id: "alice" }), 0)];
      const wa = ok(await ops(a, 1, same, "alice"));
      expect((await b.getAnnotationSet(KEY))!.annotations).toEqual([]); // A's write is invisible to B
      const wb = ok(await ops(b, 1, [create(box("pred_1_3", { author_id: "bea", bbox: [5, 5, 10, 10] }), 0)], "bea"));
      expect(wa.annotations[0]!.bbox).toEqual([100, 100, 50, 60]);
      expect(wb.annotations[0]).toMatchObject({ id: "pred_1_3", author_id: "bea", bbox: [5, 5, 10, 10] });
      const again = ok(await ops(a, 2, [{ type: "update", id: "pred_1_3", before: {}, after: { pathology: "Impacted" } }], "alice"));
      expect(again.annotations[0]).toMatchObject({ pathology: "Impacted", author_id: "alice", bbox: [100, 100, 50, 60] });
      expect((await b.getAnnotationSet(KEY))!.annotations[0]).toMatchObject({ pathology: "Caries", author_id: "bea" });
      expect((await b.getAnnotationSet(KEY))!.set.version).toBe(2);

      // B transitioning does not touch A
      await b.transitionAnnotationSet({ ...KEY, baseVersion: 2, transition: "submit", actorId: "bea", role: "annotator" });
      expect((await a.getAnnotationSet(KEY))!.set.state).toBe("draft");
      expect((await a.listAudit()).length).toBe(0);
    });

    it("answers not_found for an image the org never opened", async () => {
      const store = await makeStore();
      const repo = await newOrg(store);
      expect(await ops(repo, 1, [create(box("a"), 0)])).toEqual({ kind: "not_found" });
      expect(
        await repo.transitionAnnotationSet({ ...KEY, baseVersion: 1, transition: "submit", actorId: "a", role: "admin" }),
      ).toEqual({ kind: "not_found" });
    });

    it("keeps the model confidence on the legacy single-box insert (the old record dropped it)", async () => {
      const { repo, snap } = await setup();
      const rec = await repo.createAnnotation({
        imageId: snap.image.id, setId: null, bboxX: 1, bboxY: 2, bboxW: 3, bboxH: 4, fdiQuadrant: 1, fdiPosition: 6,
        pathology: "Caries", source: "model", status: "draft", version: 1, authorId: "alice", confidence: 0.75, modelId: "yolo-v8m",
      });
      expect(rec).toMatchObject({ confidence: 0.75, modelId: "yolo-v8m", position: 0 });
      expect(rec.clientId).toBe(rec.id);
      const listed = await repo.listAnnotations(snap.image.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ confidence: 0.75, modelId: "yolo-v8m" });
    });
  });
}
