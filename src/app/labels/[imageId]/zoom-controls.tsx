"use client";

const btn =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-700 disabled:opacity-40 dark:border-border dark:bg-card dark:text-zinc-300";

export function ZoomControls({
  scale,
  onZoomBy,
  onFit,
  onOneToOne,
  hand,
  onHand,
}: {
  scale: number;
  onZoomBy: (factor: number) => void;
  onFit: () => void;
  onOneToOne: () => void;
  hand: boolean;
  onHand: (on: boolean) => void;
}) {
  const zoomed = scale > 1;
  return (
    <div role="toolbar" aria-label="Zoom and pan" className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={() => onZoomBy(1 / 1.5)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (−)" className={btn}>
        −
      </button>
      <span data-zoom-level className="min-w-12 text-center font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
        ×{scale.toFixed(1)}
      </span>
      <button type="button" onClick={() => onZoomBy(1.5)} aria-label="Zoom in" title="Zoom in (+, or Ctrl/Cmd + wheel)" className={btn}>
        +
      </button>
      <button type="button" onClick={onFit} disabled={!zoomed} title="Whole image (Home)" className={btn}>
        Fit
      </button>
      <button type="button" onClick={onOneToOne} title="One image pixel per screen pixel" className={btn}>
        1:1
      </button>
      <button
        type="button"
        aria-pressed={hand}
        onClick={() => onHand(!hand)}
        title="Hand tool: drag to pan (hold Space, or use the middle button, for the same)"
        className={`rounded border px-2 py-1 ${hand ? "border-sky-600 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-200" : "border-zinc-300 bg-white text-zinc-700 dark:border-border dark:bg-card dark:text-zinc-300"}`}
      >
        Hand
      </button>
    </div>
  );
}
