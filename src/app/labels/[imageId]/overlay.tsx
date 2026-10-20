"use client";

/**
 * The boxes drawn over the radiograph. Two things make 500 of them cheap (ADR-0021):
 *  - each box is a memoised component of its own annotation, so a change to one box (or to the selection) renders that box,
 *    not all of them;
 *  - while a box is being dragged its position is written straight to its DOM node (`applyBoxStyle`) and committed to the
 *    history once, on release. React does not render at all between pointer events.
 */
import { memo } from "react";
import type { Annotation } from "@/shared/contracts/labels";
import type { Bbox } from "@/shared/domain/annotation";

/** Source tone of an interactive box (human, model suggestion, imported). */
export function sourceTone(source: Annotation["source"]): string {
  if (source === "gt_import") return "border-emerald-500";
  if (source === "model") return "border-sky-500";
  return "border-amber-500";
}

/** Box in dataset pixels → percent of the image, the same strings React renders and `applyBoxStyle` writes. */
export function boxStyle(b: Bbox, w: number, h: number): { left: string; top: string; width: string; height: string } {
  return {
    left: `${(b[0] / w) * 100}%`,
    top: `${(b[1] / h) * 100}%`,
    width: `${(b[2] / w) * 100}%`,
    height: `${(b[3] / h) * 100}%`,
  };
}

export function applyBoxStyle(el: HTMLElement, b: Bbox, w: number, h: number): void {
  const s = boxStyle(b, w, h);
  el.style.left = s.left;
  el.style.top = s.top;
  el.style.width = s.width;
  el.style.height = s.height;
}

const HANDLES = ["nw", "ne", "sw", "se"] as const;

export const OverlayBox = memo(function OverlayBox({
  a,
  selected,
  w,
  h,
  register,
}: {
  a: Annotation;
  selected: boolean;
  w: number;
  h: number;
  /** Lets the editor find the node to move during a drag. */
  register: (id: string, el: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={(el) => register(a.id, el)}
      className={`absolute border-2 ${sourceTone(a.source)} ${selected ? "bg-amber-300/20" : "bg-transparent"} cursor-move`}
      style={boxStyle(a.bbox as Bbox, w, h)}
      data-box-id={a.id}
    >
      {selected &&
        HANDLES.map((k) => (
          <span
            key={k}
            data-handle={k}
            className={`absolute h-2.5 w-2.5 rounded-sm border border-zinc-900 bg-white dark:bg-card ${
              k.includes("n") ? "-top-1.5" : "-bottom-1.5"
            } ${k.includes("w") ? "-left-1.5" : "-right-1.5"} cursor-pointer`}
          />
        ))}
    </div>
  );
});

/** Non-interactive reference boxes (ground truth, stored pre-labels): static, rendered once per toggle. */
export const StaticBoxes = memo(function StaticBoxes({
  items,
  className,
  w,
  h,
}: {
  items: readonly { bbox: number[] }[];
  className: string;
  w: number;
  h: number;
}) {
  return (
    <>
      {items.map((it, i) => (
        <div key={i} className={`absolute ${className}`} style={boxStyle(it.bbox as Bbox, w, h)} />
      ))}
    </>
  );
});
