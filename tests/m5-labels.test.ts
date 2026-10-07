import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LabelFixture, Annotation } from "../src/shared/contracts/labels";
import {
  agreementStats, alQueueScore, annotKey, bboxIou, can, canReview, canTransition,
  clampBox, cocoExport, cohenKappa, matchBoxes, pathologyToExportCategory, yoloLines,
} from "../src/shared/domain/annotation";
import { buildZip, crc32, listZipEntries, zipTextEntries } from "../src/shared/domain/zip";
import { fdiToClassIdx, classIdxToFdi } from "../src/shared/domain/fdi";
import type { StorageLike } from "../src/shared/lib/annotationStore";
import {
  applyDecision, ensureSet, getDecisions, getSet, listSets,
  saveAnnotations, setRole, getRole,
} from "../src/shared/lib/annotationStore";

const FIX = join(__dirname, "..", "fixtures");
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(FIX, rel), "utf-8"));

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

const ann = (over: Partial<Annotation> = {}): Annotation => ({
  id: "t",
  bbox: [10, 20, 30, 40],
  fdi_quadrant: 4,
  fdi_position: 8,
  pathology: "Caries",
  source: "human",
  confidence: null,
  status: "approved",
  version: 1,
  author_id: "demo_user",
  ...over,
});

describe("M5: label fixtures validate + GT cross-check vs trace fixtures", () => {
  const ids = ["1", "2", "3", "4", "5"];
  const fixtures = Object.fromEntries(
    ids.map((id) => [id, LabelFixture.parse(readJson(`labels/${id}.json`))]),
  );
  it("all fixtures parse; GT in-bounds, predictions (raw inference) near-bounds", () => {
    for (const id of ids) {
      const f = fixtures[id]!;
      expect(f.image_path).toBe(`/labels/${id}.jpg`);
      expect(f.variant_width).toBeLessThanOrEqual(1600);
      for (const a of f.gt) {
        const [x, y, w, h] = a.bbox;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(f.width);
        expect(y + h).toBeLessThanOrEqual(f.height);
      }
      // Raw model output may graze the image edge (image 1: lower-mandible
      // boxes overflow ≤4.3% — genuine YOLO artifact); the editor clamps on
      // import (see importPrelabels). Tolerance = 5% of the image dims.
      for (const p of f.predictions ?? []) {
        const [x, y, w, h] = p.bbox;
        expect(x).toBeGreaterThanOrEqual(-0.05 * f.width);
        expect(y).toBeGreaterThanOrEqual(-0.05 * f.height);
        expect(x + w).toBeLessThanOrEqual(1.05 * f.width);
        expect(y + h).toBeLessThanOrEqual(1.05 * f.height);
      }
    }
  });
  it("predictions are 32-class YOLO FDI boxes", () => {
    for (const id of ids) {
      const f = fixtures[id]!;
      expect(f.prediction_model).toBe("yolo_cv_best");
      for (const p of f.predictions ?? []) {
        expect(p.class_idx).toBeGreaterThanOrEqual(0);
        expect(p.class_idx).toBeLessThanOrEqual(31);
        expect(p.confidence).toBeGreaterThan(0.2);
        const { quadrant, position } = classIdxToFdi(p.class_idx);
        expect([quadrant, position]).toEqual([p.fdi_quadrant, p.fdi_position]);
      }
    }
  });
  it("GT equals the committed trace GT box-for-box (image 1, 3, 4)", () => {
    const pairs: [string, string][] = [
      ["1", "verified_with_tools"],
      ["3", "verified_healthy"],
      ["4", "unverified_dentex"],
    ];
    for (const [id, trace] of pairs) {
      const t = readJson(`traces/${trace}.json`) as {
        ground_truth: { quadrant: number; tooth_position: number; diagnosis: string; bbox: number[] }[];
      };
      const gt = fixtures[id]!.gt;
      expect(gt.length).toBe(t.ground_truth.length);
      const key = (q: number, p: number, d: string, b: number[]): string =>
        JSON.stringify([q, p, d, ...b]);
      const fromTrace = new Set(
        t.ground_truth.map((g) => key(g.quadrant, g.tooth_position, g.diagnosis, g.bbox)),
      );
      for (const g of gt) {
        expect(g.source).toBe("gt_import");
        expect(g.status).toBe("approved");
        expect(fromTrace.has(key(g.fdi_quadrant, g.fdi_position, g.pathology, [...g.bbox]))).toBe(
          true,
        );
      }
    }
  });
  it("healthy image 3 carries zero GT boxes (empty-set review case)", () => {
    expect(fixtures["3"]!.gt).toEqual([]);
  });
});

describe("M5: bbox math", () => {
  it("bboxIou: identical=1, disjoint=0, half-overlap exact", () => {
    expect(bboxIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(bboxIou([0, 0, 10, 10], [20, 20, 5, 5])).toBe(0);
    // overlap 5x10 of 10x10+10x10-50 => 50/150
    expect(bboxIou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(50 / 150, 12);
  });
  it("clampBox keeps boxes inside and rejects slivers", () => {
    expect(clampBox([-10, -10, 50, 50], 100, 100)).toEqual([0, 0, 40, 40]);
    expect(clampBox([90, 90, 50, 50], 100, 100)).toEqual([90, 90, 10, 10]);
    expect(clampBox([10, 10, 1, 1], 100, 100)).toBeNull();
    expect(clampBox([200, 200, 10, 10], 100, 100)).toBeNull();
  });
  it("matchBoxes is greedy + deterministic, threshold inclusive", () => {
    const A = [[0, 0, 10, 10], [30, 30, 10, 10]] as [number, number, number, number][];
    const B = [[0, 0, 10, 10], [31, 31, 10, 10]] as [number, number, number, number][];
    const r = matchBoxes(A, B, bboxIou, 0.5);
    expect(r.pairs.map((p) => [A.indexOf(p.a), B.indexOf(p.b)])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(r.unmatchedA).toEqual([]);
    expect(r.unmatchedB).toEqual([]);
    // exact 0.5 boundary box: overlap/union = 0.5
    const half = matchBoxes([[0, 0, 10, 10]] as [number, number, number, number][], [
      [10 - 20 / 3, 0, 10, 10],
    ] as [number, number, number, number][], bboxIou, 0.5);
    expect(half.pairs.length).toBe(1);
  });
  it("annotKey reuses the metrics normalizer (case/spelling robustness)", () => {
    expect(annotKey({ fdi_quadrant: 4, fdi_position: 8, pathology: "deep caries" })).toBe("48:Deep Caries");
    expect(annotKey({ fdi_quadrant: 1, fdi_position: 1, pathology: "  CARIES " })).toBe("11:Caries");
  });
});

describe("M5: Cohen kappa", () => {
  it("textbook 2-rater table gives the exact published value", () => {
    // Two raters, 4 "yes"+16 "no"... classic: a=20,b=5,c=10,d=65 (n=100)
    // po=(20+65)/100=0.85, pe=(25*30+75*70)/1e4=0.60, kappa=0.625
    const A: string[] = [];
    const B: string[] = [];
    const push = (a: string, b: string, n: number): void => {
      for (let i = 0; i < n; i++) {
        A.push(a);
        B.push(b);
      }
    };
    push("y", "y", 20);
    push("y", "n", 5);
    push("n", "y", 10);
    push("n", "n", 65);
    expect(cohenKappa(A, B)).toBeCloseTo(0.625, 12);
  });
  it("perfect disagreement-free multi-class labels give κ=1", () => {
    const labels = ["11:Caries", "48:Impacted", "26:Deep Caries", "11:Caries"];
    expect(cohenKappa(labels, [...labels])).toBe(1);
  });
  it("undefined cases return null instead of a fabricated number", () => {
    expect(cohenKappa([], [])).toBeNull();
    expect(cohenKappa(["a"], ["b", "c"])).toBeNull();
    expect(cohenKappa(["a", "a"], ["a", "a"])).toBeNull(); // pe==1
  });
});

describe("M5: agreementStats on real GT (self-agreement) and edited sets", () => {
  const gt = LabelFixture.parse(readJson("labels/4.json")).gt;
  it("GT vs itself: all matched, κ=1, pct=1", () => {
    const s = agreementStats("4", "a", "b", gt, gt);
    expect(s.matched).toBe(gt.length);
    expect(s.units).toBe(gt.length);
    expect(s.kappa).toBe(1);
    expect(s.pct_agree).toBe(1);
  });
  it("one dropped box becomes a <missing> unit (disagreement, strict bounds)", () => {
    const sub = gt.slice(1);
    const s = agreementStats("4", "a", "b", sub, gt);
    expect(s.units).toBe(gt.length);
    expect(s.matched).toBe(sub.length);
    expect(s.pct_agree).toBeCloseTo(sub.length / gt.length, 12);
    expect(s.kappa).not.toBeNull();
    expect(s.kappa!).toBeLessThan(1);
  });
  it("a flipped pathology lowers matched and agreement", () => {
    const flipped = gt.map((g, i) =>
      i === 0 ? { ...g, pathology: "Impacted" } : g,
    );
    const base = agreementStats("4", "a", "b", gt, gt);
    const s = agreementStats("4", "a", "b", flipped, gt);
    expect(s.matched).toBe(base.matched - 1);
    expect(s.pct_agree).toBeLessThan(1);
  });
});

describe("M5: review state machine + authorization seed", () => {
  it("legal transitions only", () => {
    expect(canTransition("draft", "submitted")).toBe(true);
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("submitted", "approved")).toBe(true);
    expect(canTransition("submitted", "rejected")).toBe(true);
    expect(canTransition("submitted", "draft")).toBe(true); // withdraw
    expect(canTransition("approved", "draft")).toBe(false); // terminal
    expect(canTransition("approved", "rejected")).toBe(false);
    expect(canTransition("rejected", "draft")).toBe(true);
    expect(canTransition("rejected", "approved")).toBe(false);
  });
  it("review requires reviewer/admin and blocks self-review", () => {
    expect(can("user", "annotate")).toBe(true);
    expect(can("user", "review")).toBe(false);
    expect(can("reviewer", "review")).toBe(true);
    expect(can("admin", "review")).toBe(true);
    expect(canReview("reviewer", false)).toBe(true);
    expect(canReview("reviewer", true)).toBe(false);
    expect(canReview("user", false)).toBe(false);
  });
});

describe("M5: AL queue heuristic", () => {
  it("uncertain, uncovered images score highest; fully covered ones score 0", () => {
    const hot = alQueueScore({ meanConf: 0.3, gtBoxes: 13, labeledBoxes: 0 });
    const done = alQueueScore({ meanConf: 1, gtBoxes: 13, labeledBoxes: 13 });
    const partial = alQueueScore({ meanConf: 0.3, gtBoxes: 13, labeledBoxes: 6 });
    expect(hot.score).toBeGreaterThan(partial.score);
    expect(partial.score).toBeGreaterThan(done.score);
    expect(done.score).toBe(0);
    expect(hot.computed_by).toBe("heuristic");
    // healthy image (no GT): coverage counted against max(1, gt)
    expect(alQueueScore({ meanConf: null, gtBoxes: 0, labeledBoxes: 0 }).score).toBe(0.65);
  });
});

describe("M5: YOLO export", () => {
  const W = 2744;
  const H = 1316;
  it("line format: class cx cy w h, 6 decimals, FDI class index", () => {
    const lines = yoloLines([ann()], W, H, false);
    const cx = ((10 + 15) / W).toFixed(6);
    const cy = ((20 + 20) / H).toFixed(6);
    expect(fdiToClassIdx(4, 8)).toBe(31);
    expect(lines).toEqual([`31 ${cx} ${cy} ${(30 / W).toFixed(6)} ${(40 / H).toFixed(6)}`]);
  });
  it("draft boxes are excluded by default, included when asked", () => {
    const draft = ann({ id: "d", status: "draft" });
    expect(yoloLines([ann(), draft], W, H)).toHaveLength(1);
    expect(yoloLines([ann(), draft], W, H, false)).toHaveLength(2);
  });
});

describe("M5: COCO export", () => {
  it("structure, 4 pathology categories, FDI extras, area math", () => {
    const images = [{ id: "4", file: "train_95.png", width: 2872, height: 1504 }];
    const doc = cocoExport(
      images,
      { "4": [ann({ pathology: "Deep Caries", fdi_quadrant: 2, fdi_position: 6 })] },
      false,
    );
    expect(doc.images).toHaveLength(1);
    expect(doc.categories.map((c) => c.name)).toEqual([
      "Impacted",
      "Caries",
      "Periapical Lesion",
      "Deep Caries",
    ]);
    expect(doc.annotations).toHaveLength(1);
    const a = doc.annotations[0]!;
    expect(a.category_id).toBe(4);
    expect(a.image_id).toBe("4");
    expect(a.area).toBe(30 * 40);
    expect(a.iscrowd).toBe(0);
    expect([a.fdi_quadrant, a.fdi_position, a.pathology]).toEqual([2, 6, "Deep Caries"]);
  });
  it("pathology spellings normalize onto categories (metrics reuse)", () => {
    const cats = [{ name: "Caries" }, { name: "Deep Caries" }];
    expect(pathologyToExportCategory("deep caries", cats)).toBe("Deep Caries");
    expect(pathologyToExportCategory("Caries", cats)).toBe("Caries");
  });
});
//__M5_DONE__


describe("M5: store-only ZIP", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("archives round-trip with exact names, sizes, and CRCs", () => {
    const files = [
      { name: "labels/1.txt", text: "31 0.1 0.2 0.3 0.4\n" },
      { name: "dataset.yaml", text: "names:\n  0: fdi_01\n" },
    ];
    const zip = buildZip(zipTextEntries(files));
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b); // PK
    const listed = listZipEntries(zip);
    expect(listed.map((e) => e.name)).toEqual(["labels/1.txt", "dataset.yaml"]);
    const enc = new TextEncoder();
    listed.forEach((e, i) => {
      const expected = enc.encode(files[i]!.text);
      expect(e.size).toBe(expected.length);
      expect(e.crc).toBe(crc32(expected));
    });
  });
  it("deterministic: same input, byte-identical output", () => {
    const f = [{ name: "a.txt", text: "hello" }];
    const a = Buffer.from(buildZip(zipTextEntries(f))).toString("hex");
    const b = Buffer.from(buildZip(zipTextEntries(f))).toString("hex");
    expect(a).toBe(b);
    expect(buildZip(zipTextEntries([])).length).toBeGreaterThan(0);
  });
});

describe("M5: annotationStore (fake storage backend)", () => {
  const mk = (): { s: StorageLike; img: string } => ({ s: memStorage(), img: "4" });
  it("ensure → save (version bump) → conflict on stale version", () => {
    const { s, img } = mk();
    const created = ensureSet(img, 14, s);
    expect(created.version).toBe(1);
    expect(created.state).toBe("draft");
    const bad = saveAnnotations(img, [{ ...ann(), id: "x" }], 0, undefined, s);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("conflict");
    const ok = saveAnnotations(img, [{ ...ann(), id: "x" }], 1, undefined, s);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.version).toBe(2);
      expect(ok.value.annotations).toHaveLength(1);
    }
  });
  it("rejects zod-invalid annotations with invalid", () => {
    const { s, img } = mk();
    ensureSet(img, 14, s);
    const bad = saveAnnotations(img, [{ ...ann(), fdi_quadrant: 9 }], 1, undefined, s);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid");
  });
  it("applyDecision only accepts submitted sets and records the trail", () => {
    const { s, img } = mk();
    ensureSet(img, 14, s);
    expect(applyDecision(img, "approved", "", "reviewer", s).ok).toBe(false);
    const sub = saveAnnotations(img, [ann()], 1, "submitted", s);
    expect(sub.ok).toBe(true);
    const dec = applyDecision(img, "rejected", "missed 48", "reviewer", s);
    expect(dec.ok).toBe(true);
    if (dec.ok) {
      expect(dec.value.state).toBe("rejected");
      expect(dec.value.annotations[0]!.status).toBe("rejected");
      expect(dec.value.version).toBe(3);
    }
    expect(getDecisions(img, s)).toHaveLength(1);
    expect(getDecisions(img, s)[0]).toMatchObject({ decision: "rejected", reason: "missed 48" });
    expect(getSet(img, s)?.state).toBe("rejected");
    expect(listSets(s).map((x) => x.image_id)).toEqual([img]);
  });
  it("role round-trips through the adapter", () => {
    const { s } = mk();
    expect(getRole(s)).toBe("user");
    setRole("reviewer", s);
    expect(getRole(s)).toBe("reviewer");
  });
});

