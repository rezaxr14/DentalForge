"use client";

import { useState } from "react";
import type { BboxT } from "@/shared/contracts/traces";

export interface OverlayBox {
  bbox: BboxT;
  label: string;
  tone: "gt" | "pred";
}

/**
 * Radiograph with ground-truth and prediction overlays.
 *
 * Coordinates are native image pixels; the SVG viewBox uses the ORIGINAL image
 * dimensions so downscaled JPEGs line up without re-scaling every box.
 */
export function Radiograph({
  src,
  width,
  height,
  gt = [],
  pred = [],
  alt,
  className,
  showLegend = true,
}: {
  src: string;
  width: number;
  height: number;
  gt?: OverlayBox[];
  pred?: OverlayBox[];
  alt: string;
  className?: string;
  showLegend?: boolean;
}) {
  const [showGt, setShowGt] = useState(true);
  const [showPred, setShowPred] = useState(true);
  const stroke = Math.max(1.5, Math.max(width, height) / 500);

  return (
    <figure className={className}>
      <div className="relative overflow-hidden rounded-xl border border-border bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="block h-auto w-full"
          style={{ aspectRatio: `${width} / ${height}` }}
        />
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {showGt &&
            gt.map((b, i) => (
              <g key={`gt-${i}`}>
                <rect
                  x={b.bbox[0]}
                  y={b.bbox[1]}
                  width={b.bbox[2]}
                  height={b.bbox[3]}
                  fill="rgba(16,185,129,0.08)"
                  stroke="#10b981"
                  strokeWidth={stroke}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          {showPred &&
            pred.map((b, i) => (
              <g key={`pred-${i}`}>
                <rect
                  x={b.bbox[0]}
                  y={b.bbox[1]}
                  width={b.bbox[2]}
                  height={b.bbox[3]}
                  fill="rgba(245,158,11,0.08)"
                  stroke="#f59e0b"
                  strokeWidth={stroke}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
        </svg>
      </div>
      {showLegend && (gt.length > 0 || pred.length > 0) && (
        <figcaption className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-600">
          {gt.length > 0 && (
            <button
              type="button"
              onClick={() => setShowGt((v) => !v)}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-1 hover:bg-accent"
              aria-pressed={showGt}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-dashed border-emerald-500" />
              Ground truth ({gt.length})
            </button>
          )}
          {pred.length > 0 && (
            <button
              type="button"
              onClick={() => setShowPred((v) => !v)}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-1 hover:bg-accent"
              aria-pressed={showPred}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-amber-500" />
              Predictions ({pred.length})
            </button>
          )}
        </figcaption>
      )}
    </figure>
  );
}

export function findingsToBoxes(
  findings: { quadrant: number; tooth_position: number; diagnosis: string; bbox?: BboxT }[],
  tone: "gt" | "pred",
): OverlayBox[] {
  return findings
    .filter((f) => f.bbox)
    .map((f) => ({
      bbox: f.bbox as BboxT,
      label: `Q${f.quadrant}T${f.tooth_position} ${f.diagnosis}`,
      tone,
    }));
}
