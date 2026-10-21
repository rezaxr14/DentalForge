"use client";

/**
 * Applies zoom and pan (ADR-0022) to the content of the annotation area. Zoom is LAYOUT zoom: the content node is sized to
 * `s` times the area and moved with a translate, so borders, handles and box edges are real fixed-size CSS pixels (a scale
 * transform snaps box edges to whole CSS pixels before scaling and clamps borders to 1 CSS pixel; both showed as uneven handles
 * and drifting frames). Boxes are percent-positioned, so a zoom step is one cheap layout, and panning is a translate only.
 * Styles are written straight to the DOM node: a wheel tick or a pan move causes no React render. Only the "×N" label is
 * state, updated at most once per frame.
 * The geometry (clamping, keeping the point under the cursor fixed, revealing a box) is the pure `domain/viewport`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  clampView, FIT, oneToOneScale, panBy as panViewBy, reveal as revealView, zoomAt,
  type Size, type View,
} from "@/shared/domain/viewport";

export interface ViewportApi {
  /** Current zoom relative to fit (state: for the label and for "is it zoomed"). */
  scale: number;
  zoomBy(factor: number, at?: { x: number; y: number }): void;
  fit(): void;
  oneToOne(): void;
  /** Pan by CSS px (e.g. from the keyboard). */
  panByPx(dx: number, dy: number): void;
  beginPan(clientX: number, clientY: number): void;
  movePan(clientX: number, clientY: number): void;
  endPan(): void;
  /** Bring a box (dataset px) into view if it is not. */
  reveal(box: readonly [number, number, number, number], imageW: number, imageH: number): void;
  /** Current view, for tests and diagnostics. */
  getView(): View;
}

export function useViewport(o: {
  regionRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** Natural width of the image in px (for "actual size"). */
  naturalWidth: number;
  announce: (message: string) => void;
}): ViewportApi {
  const { regionRef, contentRef, naturalWidth, announce } = o;
  const view = useRef<View>(FIT);
  const [scale, setScale] = useState(1);
  const frame = useRef(0);
  const pan = useRef<{ x: number; y: number; v: View } | null>(null);

  const size = useCallback((): Size => ({ w: regionRef.current?.clientWidth ?? 0, h: regionRef.current?.clientHeight ?? 0 }), [regionRef]);

  const apply = useCallback(
    (next: View): void => {
      const content = contentRef.current;
      const sz = size();
      if (!content || sz.w === 0 || sz.h === 0) return;
      const v = clampView(next, sz);
      view.current = v;
      content.style.width = `${v.s * 100}%`;
      content.style.height = `${v.s * 100}%`;
      content.style.transform = v.x === 0 && v.y === 0 ? "" : `translate(${v.x}px, ${v.y}px)`;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setScale(Math.round(v.s * 100) / 100));
    },
    [contentRef, size],
  );

  const centre = useCallback((): { x: number; y: number } => {
    const sz = size();
    return { x: sz.w / 2, y: sz.h / 2 };
  }, [size]);

  const said = useCallback(
    (v: View): void => announce(v.s === 1 ? "Whole image in view." : `Zoom ${(Math.round(v.s * 10) / 10).toFixed(1)} times.`),
    [announce],
  );

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }): void => {
      apply(zoomAt(view.current, factor, at ?? centre(), size()));
      if (!at) said(view.current);
    },
    [apply, centre, size, said],
  );

  const fit = useCallback((): void => {
    apply(FIT);
    said(FIT);
  }, [apply, said]);

  const oneToOne = useCallback((): void => {
    const sz = size();
    if (sz.w === 0) return;
    apply(zoomAt(view.current, oneToOneScale(naturalWidth, sz) / view.current.s, centre(), sz));
    said(view.current);
  }, [apply, centre, naturalWidth, said, size]);

  const panByPx = useCallback((dx: number, dy: number): void => apply(panViewBy(view.current, dx, dy, size())), [apply, size]);

  const beginPan = useCallback((x: number, y: number): void => {
    pan.current = { x, y, v: view.current };
  }, []);
  const movePan = useCallback(
    (x: number, y: number): void => {
      const p = pan.current;
      if (p) apply(panViewBy(p.v, x - p.x, y - p.y, size()));
    },
    [apply, size],
  );
  const endPan = useCallback((): void => {
    pan.current = null;
  }, []);

  const reveal = useCallback(
    (b: readonly [number, number, number, number], w: number, h: number): void => {
      if (view.current.s === 1) return;
      const next = revealView(view.current, { x: b[0] / w, y: b[1] / h, w: b[2] / w, h: b[3] / h }, size());
      if (next !== view.current) apply(next);
    },
    [apply, size],
  );

  // Ctrl/Cmd + wheel (also a trackpad pinch, which browsers deliver as ctrl+wheel) zooms at the cursor. Plain wheel still
  // scrolls the page. The listener is not passive so the browser's own page zoom can be prevented.
  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = region.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(-dy * 0.0025), { x: e.clientX - rect.left - region.clientLeft, y: e.clientY - rect.top - region.clientTop });
    };
    region.addEventListener("wheel", onWheel, { passive: false });
    return () => region.removeEventListener("wheel", onWheel);
  }, [regionRef, zoomBy]);

  // The area changes size with the window: keep the image covering it.
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => apply(view.current));
    ro.observe(region);
    return () => ro.disconnect();
  }, [regionRef, apply]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return { scale, zoomBy, fit, oneToOne, panByPx, beginPan, movePan, endPan, reveal, getView: () => view.current };
}
