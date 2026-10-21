/** Zoom/pan geometry (ADR-0022): the properties the editor relies on, including a randomised sweep. */
import { describe, expect, it } from "vitest";
import {
  clampView, FIT, imageFractionAt, MAX_SCALE, oneToOneScale, panBy, reveal, screenRect, zoomAt,
  type FractionBox, type Size, type View,
} from "@/shared/domain/viewport";

const SIZE: Size = { w: 800, h: 384 };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const covered = (v: View, s: Size) => v.x <= 1e-9 && v.y <= 1e-9 && v.x + s.w * v.s >= s.w - 1e-9 && v.y + s.h * v.s >= s.h - 1e-9;

describe("clampView", () => {
  it("fit is the identity and the smallest view: zooming out never goes below it", () => {
    expect(clampView(FIT, SIZE)).toEqual(FIT);
    expect(zoomAt(FIT, 0.1, { x: 400, y: 200 }, SIZE)).toEqual(FIT);
    expect(clampView({ s: 0.2, x: 50, y: 50 }, SIZE)).toEqual(FIT);
  });
  it("caps the scale and keeps the image covering the whole area", () => {
    expect(clampView({ s: 99, x: 0, y: 0 }, SIZE).s).toBe(MAX_SCALE);
    expect(clampView({ s: 2, x: 500, y: 500 }, SIZE)).toEqual({ s: 2, x: 0, y: 0 });
    expect(clampView({ s: 2, x: -5000, y: -5000 }, SIZE)).toEqual({ s: 2, x: -800, y: -384 });
  });
  it("repairs non-finite input instead of propagating NaN", () => {
    expect(clampView({ s: NaN, x: NaN, y: Infinity }, SIZE)).toEqual({ s: 1, x: 0, y: 0 });
  });
});

describe("zoomAt", () => {
  it("keeps the image point under the cursor where it was (random sweep, clamping aside)", () => {
    const r = rng(7);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      let v: View = FIT;
      for (let k = 0; k < 6; k++) v = zoomAt(v, 1 + r() * 1.5, { x: r() * SIZE.w, y: r() * SIZE.h }, SIZE);
      const p = { x: r() * SIZE.w, y: r() * SIZE.h };
      const before = imageFractionAt(v, p, SIZE);
      const f = 0.6 + r() * 1.6;
      const after = zoomAt(v, f, p, SIZE);
      expect(covered(after, SIZE)).toBe(true);
      // when the clamp did not have to move the view, the point under the cursor is unchanged
      const unclamped = { s: v.s * f, x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f };
      if (unclamped.s >= 1 && unclamped.s <= MAX_SCALE && clampView(unclamped, SIZE).x === unclamped.x && clampView(unclamped, SIZE).y === unclamped.y) {
        const now = imageFractionAt(after, p, SIZE);
        expect(now.x).toBeCloseTo(before.x, 9);
        expect(now.y).toBeCloseTo(before.y, 9);
        checked++;
      }
    }
    expect(checked, "the sweep must exercise the unclamped case, not vacuously pass").toBeGreaterThan(80);
  });
  it("zooming in at a corner pins that corner", () => {
    const v = zoomAt(FIT, 4, { x: 0, y: 0 }, SIZE);
    expect(v).toEqual({ s: 4, x: 0, y: 0 });
    const w = zoomAt(FIT, 4, { x: SIZE.w, y: SIZE.h }, SIZE);
    expect(w).toEqual({ s: 4, x: SIZE.w - SIZE.w * 4, y: SIZE.h - SIZE.h * 4 });
  });
  it("zoom in then out by the inverse factor at the same point returns to the start (inside the clamp)", () => {
    const start = zoomAt(FIT, 3, { x: 300, y: 150 }, SIZE);
    const there = zoomAt(start, 1.7, { x: 410, y: 190 }, SIZE);
    const back = zoomAt(there, 1 / 1.7, { x: 410, y: 190 }, SIZE);
    expect(back.s).toBeCloseTo(start.s, 9);
    expect(back.x).toBeCloseTo(start.x, 6);
    expect(back.y).toBeCloseTo(start.y, 6);
  });
});

describe("panBy, oneToOne, reveal, transform", () => {
  it("pans within the clamp and not at all at fit", () => {
    expect(panBy(FIT, 100, 100, SIZE)).toEqual(FIT);
    expect(panBy({ s: 2, x: 0, y: 0 }, -300, -50, SIZE)).toEqual({ s: 2, x: -300, y: -50 });
    expect(panBy({ s: 2, x: -790, y: 0 }, -300, 0, SIZE)).toEqual({ s: 2, x: -800, y: 0 });
  });
  it("1:1 is natural width over the area width, never below fit", () => {
    expect(oneToOneScale(2744, SIZE)).toBeCloseTo(3.43, 2);
    expect(oneToOneScale(500, SIZE)).toBe(1);
    expect(oneToOneScale(1e9, SIZE)).toBe(MAX_SCALE);
  });
  it("reveal leaves a visible box alone and centres one that is out of view", () => {
    const box: FractionBox = { x: 0.9, y: 0.4, w: 0.05, h: 0.1 };
    const v = zoomAt(FIT, 4, { x: 0, y: 0 }, SIZE); // looking at the top-left quarter
    expect(screenRect(v, box, SIZE).left).toBeGreaterThan(SIZE.w);
    const r = reveal(v, box, SIZE);
    const rect = screenRect(r, box, SIZE);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(SIZE.w);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(SIZE.h);
    expect(reveal(r, box, SIZE)).toBe(r); // already visible: same object, no movement
    expect(reveal(FIT, box, SIZE)).toBe(FIT);
  });
  it("reveal centres the box on the area when the clamp allows it", () => {
    const box: FractionBox = { x: 0.55, y: 0.45, w: 0.06, h: 0.1 };
    const v = zoomAt(FIT, 4, { x: 0, y: 0 }, SIZE); // box is outside the top-left quarter that is in view
    const r = screenRect(reveal(v, box, SIZE), box, SIZE);
    expect((r.left + r.right) / 2).toBeCloseTo(SIZE.w / 2, 6);
    expect((r.top + r.bottom) / 2).toBeCloseTo(SIZE.h / 2, 6);
  });
  it("reveal of a box in the clamp's dead zone still ends fully covered", () => {
    const edge: FractionBox = { x: 0, y: 0, w: 0.02, h: 0.02 };
    const v = zoomAt(FIT, 8, { x: SIZE.w, y: SIZE.h }, SIZE);
    const r = reveal(v, edge, SIZE);
    expect(covered(r, SIZE)).toBe(true);
    expect(screenRect(r, edge, SIZE).left).toBeGreaterThanOrEqual(0);
  });
});
