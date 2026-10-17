import { describe, expect, it } from "vitest";
import type { Annotation } from "@/shared/contracts/labels";
import {
  FDI_ENTRY_TIMEOUT_MS,
  feedDigit,
  history as H,
  initialEntry,
  mirrorAnnotation,
  nextIndex,
  odontogram,
  pathologyForCode,
} from "@/shared/domain/editing";

const ann = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id,
  bbox: [100, 100, 50, 60],
  fdi_quadrant: 3,
  fdi_position: 6,
  pathology: "Caries",
  source: "human",
  confidence: null,
  status: "draft",
  version: 1,
  author_id: "u1",
  ...over,
});
const ids = (h: H.History) => h.present.map((a) => a.id);

describe("history: create / delete / undo / redo", () => {
  it("undoes and redoes a create, and a new action clears redo", () => {
    let h = H.createHistory([]);
    h = H.create(h, ann("a"));
    h = H.create(h, ann("b"));
    expect(ids(h)).toEqual(["a", "b"]);
    h = H.undo(h);
    expect(ids(h)).toEqual(["a"]);
    expect(H.canRedo(h)).toBe(true);
    h = H.redo(h);
    expect(ids(h)).toEqual(["a", "b"]);
    h = H.undo(h);
    h = H.create(h, ann("c"));
    expect(H.canRedo(h)).toBe(false);
    expect(ids(h)).toEqual(["a", "c"]);
  });

  it("undoing a delete puts the box back at its ORIGINAL index", () => {
    let h = H.createHistory([ann("a"), ann("b"), ann("c")]);
    h = H.remove(h, "b");
    expect(ids(h)).toEqual(["a", "c"]);
    h = H.undo(h);
    expect(ids(h)).toEqual(["a", "b", "c"]);
    h = H.redo(h);
    expect(ids(h)).toEqual(["a", "c"]);
  });

  it("ignores unknown ids and duplicate creates without recording a step", () => {
    const h = H.createHistory([ann("a")]);
    expect(H.remove(h, "zzz")).toBe(h);
    expect(H.update(h, "zzz", { pathology: "Impacted" })).toBe(h);
    expect(H.create(h, ann("a"))).toBe(h);
    expect(H.undo(h)).toBe(h);
    expect(H.redo(h)).toBe(h);
  });

  it("a no-op update (same values) records nothing", () => {
    const h = H.createHistory([ann("a")]);
    expect(H.update(h, "a", { pathology: "Caries" })).toBe(h);
    expect(H.update(h, "a", { bbox: [100, 100, 50, 60] })).toBe(h);
  });
});

describe("history: labels and batches", () => {
  it("records label edits as setLabel and geometry as update", () => {
    let h = H.createHistory([ann("a")]);
    h = H.update(h, "a", { fdi_quadrant: 4, fdi_position: 6 });
    h = H.update(h, "a", { bbox: [1, 2, 30, 40] });
    expect(h.past.map((e) => e.command.type)).toEqual(["setLabel", "update"]);
  });

  it("undo restores every changed field, and an edit never touches status (ADR-0020)", () => {
    let h = H.createHistory([ann("a", { status: "approved" })]);
    h = H.update(h, "a", { pathology: "Impacted", fdi_position: 2 });
    expect(h.present[0]).toMatchObject({ pathology: "Impacted", fdi_position: 2, status: "approved" });
    h = H.undo(h);
    expect(h.present[0]).toMatchObject({ pathology: "Caries", fdi_position: 6, status: "approved" });
  });

  it("createMany is ONE undo step and skips ids that already exist", () => {
    let h = H.createHistory([ann("a")]);
    h = H.createMany(h, [ann("a"), ann("p1"), ann("p2")], "Imported pre-labels");
    expect(ids(h)).toEqual(["a", "p1", "p2"]);
    expect(h.past).toHaveLength(1);
    h = H.undo(h);
    expect(ids(h)).toEqual(["a"]);
    h = H.redo(h);
    expect(ids(h)).toEqual(["a", "p1", "p2"]);
    expect(H.createMany(h, [ann("p1")], "again")).toBe(h);
    expect(H.createMany(h, [], "none")).toBe(h);
  });

  it("reset replaces the state and forgets history", () => {
    let h = H.create(H.createHistory([]), ann("a"));
    h = H.reset(h, [ann("x")]);
    expect(ids(h)).toEqual(["x"]);
    expect(H.canUndo(h) || H.canRedo(h)).toBe(false);
  });
});

describe("history: inverting a batch", () => {
  it("undoes in reverse order, so steps that touch the same box unwind correctly", () => {
    const step = (before: number, after: number): H.Command => ({ type: "update", id: "a", before: { bbox: [before, 0, 10, 10] }, after: { bbox: [after, 0, 10, 10] } });
    const batch: H.Command = { type: "batch", label: "two moves", commands: [step(1, 2), step(2, 3)] };
    const moved = H.apply([ann("a", { bbox: [1, 0, 10, 10] })], batch);
    expect(moved[0]?.bbox).toEqual([3, 0, 10, 10]);
    const back = H.apply(moved, H.invert(batch));
    expect(back[0]?.bbox).toEqual([1, 0, 10, 10]);
  });
});

describe("history: drag coalescing", () => {
  const drag = (h: H.History, key: string, id: string, xs: number[]) =>
    xs.reduce((acc, x) => H.update(acc, id, { bbox: [x, 100, 50, 60] }, { coalesceKey: key }), h);

  it("a whole drag is one undo step that returns to the box's original position", () => {
    let h = H.createHistory([ann("a")]);
    h = drag(h, "g1", "a", [110, 120, 130, 140, 150]);
    expect(h.present[0]?.bbox).toEqual([150, 100, 50, 60]);
    expect(h.past).toHaveLength(1);
    h = H.undo(h);
    expect(h.present[0]?.bbox).toEqual([100, 100, 50, 60]);
    h = H.redo(h);
    expect(h.present[0]?.bbox).toEqual([150, 100, 50, 60]);
  });

  it("different gestures, or different boxes, are separate steps", () => {
    let h = H.createHistory([ann("a"), ann("b")]);
    h = drag(h, "g1", "a", [110, 120]);
    h = drag(h, "g2", "a", [130, 140]);
    h = drag(h, "g3", "b", [200]);
    expect(h.past).toHaveLength(3);
  });

  it("the same key on a different box is a separate step", () => {
    let h = H.createHistory([ann("a"), ann("b")]);
    h = H.update(h, "a", { bbox: [110, 100, 50, 60] }, { coalesceKey: "g1" });
    h = H.update(h, "b", { bbox: [210, 100, 50, 60] }, { coalesceKey: "g1" });
    expect(h.past).toHaveLength(2);
    h = H.undo(h);
    expect(h.present.find((a) => a.id === "a")?.bbox).toEqual([110, 100, 50, 60]);
    expect(h.present.find((a) => a.id === "b")?.bbox).toEqual([100, 100, 50, 60]);
  });

  it("an update without a key never coalesces", () => {
    let h = H.createHistory([ann("a")]);
    h = H.update(h, "a", { bbox: [110, 100, 50, 60] });
    h = H.update(h, "a", { bbox: [120, 100, 50, 60] });
    expect(h.past).toHaveLength(2);
  });

  it("a drag that ends where it started leaves no undo step", () => {
    let h = H.createHistory([ann("a")]);
    h = drag(h, "g1", "a", [110, 120, 100]);
    expect(h.present[0]?.bbox).toEqual([100, 100, 50, 60]);
    expect(H.canUndo(h)).toBe(false);
  });

  it("a redone step is not merged into a later gesture that reuses its key", () => {
    let h = H.createHistory([ann("a")]);
    h = drag(h, "g1", "a", [110]);
    h = H.undo(h);
    h = H.redo(h);
    h = drag(h, "g1", "a", [160]);
    expect(h.past).toHaveLength(2);
    h = H.undo(h);
    expect(h.present[0]?.bbox).toEqual([110, 100, 50, 60]);
  });
});

describe("history: any sequence of edits can be fully undone and redone", () => {
  it("random walk (seeded) returns to the start, then to the end", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const start = [ann("s1"), ann("s2")];
    let h = H.createHistory(start);
    let next = 0;
    for (let i = 0; i < 200; i++) {
      const pick = h.present[rnd(h.present.length) % Math.max(h.present.length, 1)];
      switch (rnd(5)) {
        case 0: h = H.create(h, ann(`n${next++}`, { bbox: [rnd(500), rnd(500), 10 + rnd(50), 10 + rnd(50)] })); break;
        case 1: if (pick) h = H.remove(h, pick.id); break;
        case 2: if (pick) h = H.update(h, pick.id, { fdi_quadrant: 1 + rnd(4), fdi_position: 1 + rnd(8) }); break;
        case 3: if (pick) h = H.update(h, pick.id, { bbox: [rnd(500), rnd(500), 10 + rnd(50), 10 + rnd(50)] }, { coalesceKey: `g${rnd(3)}` }); break;
        default: h = H.createMany(h, [ann(`m${next++}`), ann(`m${next++}`)], "batch");
      }
    }
    const end = h.present;
    const steps = h.past.length;
    expect(steps).toBeGreaterThan(20);
    for (let i = 0; i < steps; i++) h = H.undo(h);
    expect(h.present).toEqual(start);
    for (let i = 0; i < steps; i++) h = H.redo(h);
    expect(h.present).toEqual(end);
  });
});

describe("FDI quick entry", () => {
  const type = (digits: string, t0 = 1000) => {
    let s = initialEntry;
    let commit: { quadrant: number; position: number } | undefined;
    let t = t0;
    for (const d of digits) {
      const r = feedDigit(s, d, t);
      s = r.state;
      commit = r.commit ?? commit;
      t += 100;
    }
    return { s, commit };
  };

  it("4 then 6 sets tooth 46", () => {
    expect(type("46").commit).toEqual({ quadrant: 4, position: 6 });
  });

  it("the first digit must be a quadrant (1-4); other digits are not consumed", () => {
    for (const d of ["0", "5", "6", "9"]) {
      const r = feedDigit(initialEntry, d, 1);
      expect(r.consumed).toBe(false);
      expect(r.state.quadrant).toBeNull();
    }
    expect(feedDigit(initialEntry, "3", 1)).toMatchObject({ consumed: true, state: { quadrant: 3 } });
  });

  it("the second digit must be a position (1-8); 0 and 9 abandon the entry and are swallowed", () => {
    for (const d of ["0", "9"]) {
      const r = feedDigit({ quadrant: 2, at: 0 }, d, 100);
      expect(r).toMatchObject({ consumed: true, state: { quadrant: null } });
      expect(r.commit).toBeUndefined();
    }
    expect(feedDigit({ quadrant: 2, at: 0 }, "8", 100).commit).toEqual({ quadrant: 2, position: 8 });
    expect(feedDigit({ quadrant: 2, at: 0 }, "1", 100).commit).toEqual({ quadrant: 2, position: 1 });
  });

  it("a pending quadrant expires after the timeout (the boundary itself still counts)", () => {
    expect(feedDigit({ quadrant: 4, at: 0 }, "6", FDI_ENTRY_TIMEOUT_MS).commit).toEqual({ quadrant: 4, position: 6 });
    const late = feedDigit({ quadrant: 4, at: 0 }, "6", FDI_ENTRY_TIMEOUT_MS + 1);
    expect(late.commit).toBeUndefined();
    expect(late.consumed).toBe(false); // "6" is not a quadrant, so it starts nothing
    expect(feedDigit({ quadrant: 4, at: 0 }, "3", FDI_ENTRY_TIMEOUT_MS + 1)).toMatchObject({ state: { quadrant: 3 } });
  });

  it("non-digits are not ours and clear the pending quadrant", () => {
    const r = feedDigit({ quadrant: 4, at: 0 }, "a", 10);
    expect(r.consumed).toBe(false);
    expect(r.state.quadrant).toBeNull();
    expect(feedDigit(initialEntry, "10", 1).consumed).toBe(false);
    // a multi-character key name such as "12" is not a digit key, even while a quadrant is pending
    const pending = feedDigit({ quadrant: 2, at: 0 }, "12", 10);
    expect(pending.consumed).toBe(false);
    expect(pending.commit).toBeUndefined();
  });

  it("pathology hotkeys are Alt+Digit1..4 by physical key", () => {
    expect(pathologyForCode("Digit1")).toBe("Caries");
    expect(pathologyForCode("Digit2")).toBe("Deep Caries");
    expect(pathologyForCode("Digit3")).toBe("Periapical Lesion");
    expect(pathologyForCode("Digit4")).toBe("Impacted");
    for (const c of ["Digit0", "Digit5", "KeyA", "Numpad1", ""]) expect(pathologyForCode(c)).toBeNull();
  });
});

describe("odontogram", () => {
  it("has 32 slots, upper row 18..11 then 21..28, lower row 48..41 then 31..38", () => {
    const o = odontogram([]);
    expect(o.upper.map((s) => s.fdi)).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]);
    expect(o.lower.map((s) => s.fdi)).toEqual([48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(o.labeled).toBe(0);
    expect(o.conflicts).toEqual([]);
  });

  it("marks labeled and conflicting slots and lists the conflicts", () => {
    const o = odontogram([
      ann("a", { fdi_quadrant: 4, fdi_position: 6 }),
      ann("b", { fdi_quadrant: 1, fdi_position: 1 }),
      ann("c", { fdi_quadrant: 4, fdi_position: 6 }),
      ann("d", { fdi_quadrant: 4, fdi_position: 6 }),
      ann("e", { fdi_quadrant: 3, fdi_position: 8 }),
      ann("f", { fdi_quadrant: 3, fdi_position: 8 }),
    ]);
    const slot = (fdi: number) => [...o.upper, ...o.lower].find((s) => s.fdi === fdi);
    expect(slot(46)).toMatchObject({ state: "conflict", ids: ["a", "c", "d"] });
    expect(slot(11)).toMatchObject({ state: "labeled", ids: ["b"] });
    expect(slot(38)).toMatchObject({ state: "conflict" });
    expect(slot(12)).toMatchObject({ state: "empty", ids: [] });
    expect(o.labeled).toBe(3);
    expect(o.conflicts.sort()).toEqual([38, 46]);
  });

  it("ignores boxes whose label is outside the 32 permanent slots", () => {
    const o = odontogram([ann("x", { fdi_quadrant: 5, fdi_position: 1 }), ann("y", { fdi_quadrant: 1, fdi_position: 9 })]);
    expect(o.labeled).toBe(0);
  });
});

describe("mirror", () => {
  const img = { width: 1000, height: 500 };
  const meta = { id: "m1", authorId: "u2" };

  it("reflects across the vertical midline, flips the quadrant, keeps position and pathology", () => {
    const m = mirrorAnnotation(ann("a", { bbox: [100, 50, 80, 120], fdi_quadrant: 3, fdi_position: 6, pathology: "Impacted" }), img, meta);
    expect(m).toMatchObject({ id: "m1", bbox: [820, 50, 80, 120], fdi_quadrant: 4, fdi_position: 6, pathology: "Impacted", author_id: "u2" });
    for (const [q, f] of [[1, 2], [2, 1], [3, 4], [4, 3]] as const) {
      expect(mirrorAnnotation(ann("a", { fdi_quadrant: q }), img, meta)?.fdi_quadrant).toBe(f);
    }
  });

  it("the copy is a fresh human draft, whatever the source was", () => {
    const m = mirrorAnnotation(ann("a", { source: "model", confidence: 0.9, status: "approved", version: 7 }), img, meta);
    expect(m).toMatchObject({ source: "human", confidence: null, status: "draft", version: 1 });
  });

  it("mirroring twice gives back the original box", () => {
    const a = ann("a", { bbox: [123, 40, 77, 90], fdi_quadrant: 1, fdi_position: 3 });
    const twice = mirrorAnnotation(mirrorAnnotation(a, img, meta)!, img, meta)!;
    expect(twice.bbox).toEqual(a.bbox);
    expect(twice.fdi_quadrant).toBe(1);
  });

  it("stays inside the image, and gives up when nothing usable is left", () => {
    const edge = mirrorAnnotation(ann("a", { bbox: [0, 0, 60, 60] }), img, meta);
    expect(edge?.bbox).toEqual([940, 0, 60, 60]);
    expect(mirrorAnnotation(ann("a", { bbox: [0, 0, 2, 2] }), img, meta)).toBeNull(); // below the 4 px minimum
  });
});

describe("nextIndex", () => {
  it("is 0 for nothing and the count for ids without a numeric suffix", () => {
    expect(nextIndex([])).toBe(0);
    expect(nextIndex([{ id: "a" }, { id: "b" }])).toBe(2);
  });

  it("never reuses a suffix after a delete (the bug it replaces: ids from annotations.length)", () => {
    const afterDelete = [{ id: "pred_1_0" }, { id: "pred_1_2" }]; // pred_1_1 was deleted: length is 2, but 2 is taken
    expect(nextIndex(afterDelete)).toBe(3);
    expect(nextIndex([{ id: "ann_k3x9_41" }])).toBe(42);
  });

  it("takes the largest suffix, not the last one", () => {
    expect(nextIndex([{ id: "p_9" }, { id: "p_3" }, { id: "p_5" }])).toBe(10);
  });
});

describe("history: describe", () => {
  it("names each kind of step", () => {
    const a = ann("a");
    expect(H.describe({ type: "create", annotation: a, index: 0 })).toBe("draw box");
    expect(H.describe({ type: "delete", annotation: a, index: 0 })).toBe("delete box");
    expect(H.describe({ type: "update", id: "a", before: {}, after: {} })).toBe("move or resize box");
    expect(H.describe({ type: "setLabel", id: "a", before: {}, after: {} })).toBe("change label");
    expect(H.describe({ type: "batch", label: "Import pre-labels", commands: [] })).toBe("import pre-labels");
  });
});
