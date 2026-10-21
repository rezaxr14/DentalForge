/**
 * Zoom and pan of the radiograph (ADR-0022). Pure geometry, no DOM.
 *
 * The image fills the annotation area (`size`) at fit; zoomed, it is `s` times that size, positioned by a translation (x, y)
 * of its top-left corner. `s = 1` is "fit": the whole image, which is also the smallest allowed scale, so there is never an empty margin.
 * Every operation returns a clamped view: the zoomed image always covers the whole area.
 */
export interface View {
  /** Scale relative to fit (1 = whole image visible). */
  s: number;
  /** Translation in CSS px of the area; always in [size − size·s, 0]. */
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
/** A box as fractions of the image (0..1), e.g. `bbox / imageSize`. */
export interface FractionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FIT: View = { s: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 16;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function clampView(v: View, size: Size): View {
  const s = clamp(Number.isFinite(v.s) ? v.s : 1, MIN_SCALE, MAX_SCALE);
  return {
    s,
    x: clamp(Number.isFinite(v.x) ? v.x : 0, Math.min(0, size.w - size.w * s), 0),
    y: clamp(Number.isFinite(v.y) ? v.y : 0, Math.min(0, size.h - size.h * s), 0),
  };
}

/** Scale by `factor` keeping the image point under `p` (area coordinates, px) where it is. */
export function zoomAt(v: View, factor: number, p: Point, size: Size): View {
  const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
  const ratio = s / v.s;
  return clampView({ s, x: p.x - (p.x - v.x) * ratio, y: p.y - (p.y - v.y) * ratio }, size);
}

export function panBy(v: View, dx: number, dy: number, size: Size): View {
  return clampView({ ...v, x: v.x + dx, y: v.y + dy }, size);
}

/** Scale at which one image pixel is one CSS pixel (relative to fit): `naturalWidth / size.w`, at least fit. */
export function oneToOneScale(naturalWidth: number, size: Size): number {
  return clamp(naturalWidth / size.w, MIN_SCALE, MAX_SCALE);
}

/** The image fraction (0..1) shown at area point `p`. */
export function imageFractionAt(v: View, p: Point, size: Size): Point {
  return { x: (p.x - v.x) / (size.w * v.s), y: (p.y - v.y) / (size.h * v.s) };
}

/** Where a fraction box lands in the area, in px. */
export function screenRect(v: View, b: FractionBox, size: Size): { left: number; top: number; right: number; bottom: number } {
  const left = v.x + b.x * size.w * v.s;
  const top = v.y + b.y * size.h * v.s;
  return { left, top, right: left + b.w * size.w * v.s, bottom: top + b.h * size.h * v.s };
}

/**
 * Make sure `b` is in view: unchanged when it already is (with `margin` px to spare), otherwise centred on the box
 * (as far as the clamp allows). Used when the selection moves by keyboard, table or odontogram.
 */
export function reveal(v: View, b: FractionBox, size: Size, margin = 24): View {
  const r = screenRect(v, b, size);
  if (r.left >= margin && r.top >= margin && r.right <= size.w - margin && r.bottom <= size.h - margin) return v;
  const cx = (b.x + b.w / 2) * size.w * v.s;
  const cy = (b.y + b.h / 2) * size.h * v.s;
  return clampView({ s: v.s, x: size.w / 2 - cx, y: size.h / 2 - cy }, size);
}
