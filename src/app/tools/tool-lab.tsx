"use client";

import { useEffect, useRef, useState } from "react";
import {
  WINDOW_PRESETS, type Rgb, contralateralComposite, denoiseBilateral,
  denoiseMedian, enhanceContrast, windowLevel,
} from "@/shared/domain/toolImage";
import { boxOutOfBounds, nudgeCrop, zoomCropRect } from "@/shared/domain/toolGeometry";
import { anatomicalName, fdiFromParts, fdiLabel, flipQuadrant } from "@/shared/domain/fdi";

type ToolId =
  | "enhance_contrast" | "window_level" | "denoise" | "zoom_crop"
  | "nudge_crop" | "contralateral_compare" | "fdi_label" | "locate_tooth";

const TOOLS: { id: ToolId; label: string }[] = [
  { id: "enhance_contrast", label: "enhance_contrast" },
  { id: "window_level", label: "window_level" },
  { id: "denoise", label: "denoise" },
  { id: "zoom_crop", label: "zoom_crop" },
  { id: "nudge_crop", label: "nudge_crop" },
  { id: "contralateral_compare", label: "contralateral_compare" },
  { id: "fdi_label", label: "fdi_label" },
  { id: "locate_tooth", label: "locate_tooth" },
];

interface Params {
  factor: number; preset: string; center: number; width: number;
  method: "median" | "bilateral"; strength: number;
  padFrac: number; dx: number; dy: number; scale: number;
  quadrant: number; position: number;
}

const DEFAULTS: Params = {
  factor: 1.5, preset: "bone", center: 128, width: 100,
  method: "median", strength: 0.6,
  padFrac: 0.25, dx: 0, dy: 0, scale: 1,
  quadrant: 3, position: 6,
};

interface Src { img: HTMLImageElement; data: Uint8ClampedArray; w: number; h: number }
interface Result { w: number; h: number; data: Uint8ClampedArray; info: Record<string, unknown> }

const toRgb = (rgba: Uint8ClampedArray): Rgb => {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[3 * i] = rgba[4 * i]!; out[3 * i + 1] = rgba[4 * i + 1]!; out[3 * i + 2] = rgba[4 * i + 2]!;
  }
  return out;
};

const toRgba = (rgb: Rgb): Uint8ClampedArray => {
  const n = rgb.length / 3;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[4 * i] = rgb[3 * i]!; out[4 * i + 1] = rgb[3 * i + 1]!;
    out[4 * i + 2] = rgb[3 * i + 2]!; out[4 * i + 3] = 255;
  }
  return out;
};

/** Crop the original RGBA buffer to a clamped integer rect. */
function cropRgba(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  l: number, t: number, r: number, b: number,
): { w: number; h: number; data: Uint8ClampedArray } {
  const L = Math.max(0, Math.floor(l)), T = Math.max(0, Math.floor(t));
  const R = Math.min(imgW, Math.ceil(r)), B = Math.min(imgH, Math.ceil(b));
  const w = Math.max(1, R - L), h = Math.max(1, B - T);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((T + y) * imgW + L) * 4;
    out.set(data.subarray(s, s + w * 4), y * w * 4);
  }
  return { w, h, data: out };
}

/** Downscale helper for heavy pixel tools (denoise preview). */
function resample(img: HTMLImageElement, targetW: number): { w: number; h: number; data: Uint8ClampedArray } {
  const scale = Math.min(1, targetW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

function compute(
  tool: ToolId, src: Src, bb: { x: number; y: number; w: number; h: number }, p: Params,
): Result {
  const bbox: [number, number, number, number] = [bb.x, bb.y, bb.w, bb.h];
  if (tool === "enhance_contrast") {
    const out = enhanceContrast(toRgb(src.data), p.factor);
    return { w: src.w, h: src.h, data: toRgba(out), info: { factor: p.factor, mode: "PIL contrast (exact)" } };
  }
  if (tool === "window_level") {
    const out = windowLevel(toRgb(src.data), p.preset, p.center, p.width);
    const preset = WINDOW_PRESETS[p.preset] ?? WINDOW_PRESETS.bone!;
    return {
      w: src.w, h: src.h, data: toRgba(out),
      info: { preset: p.preset, preset_defaults: preset, center: p.center, width: p.width },
    };
  }
  if (tool === "denoise") {
    const prev = resample(src.img, 720); // heavy O(w·h·k²) — preview at ≤720px
    const rgb = toRgb(prev.data);
    const out = p.method === "median"
      ? denoiseMedian(rgb, prev.w, prev.h, p.strength)
      : denoiseBilateral(rgb, prev.w, prev.h, p.strength);
    const k = Math.max(3, Math.round(3 + p.strength * 10) | 1);
    const d = Math.round(5 + p.strength * 20);
    const sigma = Math.round(20 + p.strength * 180);
    return {
      w: prev.w, h: prev.h, data: toRgba(out),
      info: {
        method: p.method, strength: p.strength,
        ...(p.method === "median" ? { ksize: k } : { d, sigmaColor: sigma, sigmaSpace: sigma }),
        preview_scale: Number((prev.w / src.w).toFixed(3)),
      },
    };
  }
  if (tool === "zoom_crop") {
    const rect = zoomCropRect(src.w, src.h, bbox, p.padFrac);
    const c = cropRgba(src.data, src.w, src.h, rect.left, rect.top, rect.right, rect.bottom);
    return {
      ...c,
      info: {
        args: { bbox, padding_frac: p.padFrac },
        rect: [rect.left, rect.top, rect.right, rect.bottom],
        out_of_bounds: boxOutOfBounds(bbox, src.w, src.h),
      },
    };
  }
  if (tool === "nudge_crop") {
    const n = nudgeCrop(src.w, src.h, bbox, p.dx, p.dy, p.scale);
    const args = { bbox, dx_frac: p.dx, dy_frac: p.dy, scale: p.scale };
    if (n.bbox) {
      const [nx, ny, nw, nh] = n.bbox;
      const c = cropRgba(src.data, src.w, src.h, nx, ny, nx + nw, ny + nh);
      return { ...c, info: { args, result: n } };
    }
    return { w: src.w, h: src.h, data: src.data.slice(), info: { args, error: n.error } };
  }
  // contralateral_compare
  const comp = contralateralComposite(toRgb(src.data), src.w, src.h, bbox, p.quadrant);
  const tx = Math.max(0, bb.x), ty = Math.max(0, bb.y);
  const tw = Math.min(src.w, bb.x + bb.w) - tx, th = Math.min(src.h, bb.y + bb.h) - ty;
  let fallback: string | null = null;
  if (tw <= 0 || th <= 0 || (comp.w === src.w && comp.h === src.h)) fallback = "full_image (invalid bbox)";
  else if (comp.w === tw && comp.h === th) fallback = "target_only (mirror degenerate)";
  return {
    w: comp.w, h: comp.h, data: toRgba(comp.data),
    info: { args: { bbox, quadrant: p.quadrant }, composite_size: [comp.w, comp.h], fallback },
  };
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-zinc-600">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </span>
      <input
        type="range" className="mt-1 w-full accent-zinc-700"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function ToolLab() {
  const [src, setSrc] = useState<Src | null>(null);
  const [tool, setTool] = useState<ToolId>("enhance_contrast");
  const [bb, setBb] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [p, setP] = useState<Params>(DEFAULTS);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const srcCanvasRef = useRef<HTMLCanvasElement>(null);
  const outCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x0: number; y0: number } | null>(null);

  // load the sample radiograph once
  useEffect(() => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      setSrc({ img: im, data: d, w: c.width, h: c.height });
      setBb({
        x: Math.round(c.width * 0.3), y: Math.round(c.height * 0.25),
        w: Math.round(c.width * 0.18), h: Math.round(c.height * 0.45),
      });
    };
    im.src = "/radiograph.jpg";
  }, []);

  // draw source + bbox overlay
  useEffect(() => {
    if (!src || !srcCanvasRef.current) return;
    const cv = srcCanvasRef.current;
    cv.width = src.w; cv.height = src.h;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(src.img, 0, 0);
    if (tool !== "fdi_label" && tool !== "locate_tooth") {
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = Math.max(2, Math.round(src.w / 500));
      ctx.strokeRect(bb.x, bb.y, bb.w, bb.h);
    }
  }, [src, bb, tool]);

  // debounced processing (setState only in callbacks; rAF paints the busy flag first)
  useEffect(() => {
    if (!src || tool === "fdi_label" || tool === "locate_tooth") return;
    let raf = 0;
    const id = setTimeout(() => {
      setBusy(true);
      raf = requestAnimationFrame(() => {
        setResult(compute(tool, src, bb, p));
        setBusy(false);
      });
    }, 60);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(raf);
    };
  }, [src, tool, bb, p]);

  // draw result (tool in deps: canvas remounts when tabs switch)
  useEffect(() => {
    const cv = outCanvasRef.current;
    if (!cv || !result) return;
    cv.width = result.w; cv.height = result.h;
    const ctx = cv.getContext("2d")!;
    const id = ctx.createImageData(result.w, result.h);
    id.data.set(result.data);
    ctx.putImageData(id, 0, 0);
  }, [result, tool]);

  const toImg = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = srcCanvasRef.current!;
    const r = cv.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(cv.width, Math.round((e.clientX - r.left) * (cv.width / r.width)))),
      y: Math.max(0, Math.min(cv.height, Math.round((e.clientY - r.top) * (cv.height / r.height)))),
    };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === "fdi_label" || tool === "locate_tooth") return;
    const pt = toImg(e);
    dragRef.current = { x0: pt.x, y0: pt.y };
    setBb({ x: pt.x, y: pt.y, w: 1, h: 1 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = dragRef.current;
    if (!s) return;
    const pt = toImg(e);
    setBb({
      x: Math.min(s.x0, pt.x), y: Math.min(s.y0, pt.y),
      w: Math.max(1, Math.abs(pt.x - s.x0)), h: Math.max(1, Math.abs(pt.y - s.y0)),
    });
  };
  const onUp = () => { dragRef.current = null; };

  const patch = (v: Partial<Params>) => setP((old) => ({ ...old, ...v }));
  const onTab = (id: ToolId) => {
    setTool(id);
    if (id === "fdi_label" || id === "locate_tooth") setResult(null);
  };
  const fdiInfo = tool === "fdi_label"
    ? {
        quadrant: p.quadrant, position: p.position,
        label: fdiLabel(p.quadrant, p.position),
        fdi: fdiFromParts(p.quadrant, p.position),
        anatomy: anatomicalName(fdiFromParts(p.quadrant, p.position)),
        flip: { quadrant: flipQuadrant(p.quadrant), label: fdiLabel(flipQuadrant(p.quadrant), p.position) },
      }
    : null;
  const info: unknown = tool === "locate_tooth" ? { tool: "locate_tooth", browser_tier: false } : (result?.info ?? fdiInfo);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-2">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={`rounded border px-3 py-1.5 font-mono text-xs transition-colors ${
              tool === t.id
                ? "border-zinc-800 bg-zinc-800 text-white"
                : "border-zinc-300 bg-white hover:bg-zinc-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-sm font-medium text-zinc-700">
            Source{" "}
            <span className="font-mono text-xs text-zinc-400">
              {src ? `${src.w}×${src.h}` : "loading…"}
            </span>
          </h2>
          <canvas
            ref={srcCanvasRef}
            className="mt-2 w-full cursor-crosshair touch-none rounded border border-zinc-300"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          />
          <p className="mt-1 font-mono text-xs text-zinc-500">
            bbox: [{bb.x}, {bb.y}, {bb.w}, {bb.h}] — drag on image to adjust
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {tool === "enhance_contrast" && (
              <Slider label="factor" value={p.factor} min={0} max={3} step={0.05}
                onChange={(v) => patch({ factor: v })} />
            )}
            {tool === "window_level" && (
              <>
                <label className="block">
                  <span className="text-xs text-zinc-600">preset</span>
                  <select
                    className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                    value={p.preset}
                    onChange={(e) => {
                      const preset = e.target.value;
                      const d = WINDOW_PRESETS[preset] ?? WINDOW_PRESETS.bone!;
                      patch({ preset, center: d.center, width: d.width });
                    }}
                  >
                    {Object.keys(WINDOW_PRESETS).map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <Slider label="center (override)" value={p.center} min={0} max={255} step={1}
                  onChange={(v) => patch({ center: v })} />
                <Slider label="width (override)" value={p.width} min={1} max={255} step={1}
                  onChange={(v) => patch({ width: v })} />
              </>
            )}
            {tool === "denoise" && (
              <>
                <label className="block">
                  <span className="text-xs text-zinc-600">method</span>
                  <select
                    className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                    value={p.method}
                    onChange={(e) => patch({ method: e.target.value as Params["method"] })}
                  >
                    <option value="median">median (cv2-exact)</option>
                    <option value="bilateral">bilateral (cv2-exact)</option>
                  </select>
                </label>
                <Slider label="strength" value={p.strength} min={0} max={1} step={0.1}
                  onChange={(v) => patch({ strength: v })} />
              </>
            )}
            {tool === "zoom_crop" && (
              <Slider label="padding_frac" value={p.padFrac} min={0} max={1} step={0.05}
                onChange={(v) => patch({ padFrac: v })} />
            )}
            {tool === "nudge_crop" && (
              <>
                <Slider label="dx_frac" value={p.dx} min={-1} max={1} step={0.05}
                  onChange={(v) => patch({ dx: v })} />
                <Slider label="dy_frac" value={p.dy} min={-1} max={1} step={0.05}
                  onChange={(v) => patch({ dy: v })} />
                <Slider label="scale" value={p.scale} min={0.1} max={2} step={0.1}
                  onChange={(v) => patch({ scale: v })} />
              </>
            )}
            {(tool === "contralateral_compare" || tool === "fdi_label") && (
              <label className="block">
                <span className="text-xs text-zinc-600">quadrant (FDI)</span>
                <select
                  className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  value={p.quadrant}
                  onChange={(e) => patch({ quadrant: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>{q}</option>
                  ))}
                </select>
              </label>
            )}
            {tool === "fdi_label" && (
              <label className="block">
                <span className="text-xs text-zinc-600">position</span>
                <select
                  className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  value={p.position}
                  onChange={(e) => patch({ position: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </section>

        <section>
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            Result
            {busy && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                processing…
              </span>
            )}
          </h2>
          {tool === "locate_tooth" ? (
            <div className="mt-2 rounded border border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-600">
              <p className="font-medium text-zinc-800">
                locate_tooth runs the YOLO detector inside the VLM-DENTAL agent runtime.
              </p>
              <p className="mt-2">
                Model inference cannot run in the browser tier (plan §9) — this is the one tool of
                the 8 registry tools not ported client-side. See its real outputs on Trace Explorer;
                reference renders live in <span className="font-mono text-xs">docs/images/</span>{" "}
                (154 assets, not yet ported).
              </p>
            </div>
          ) : tool !== "fdi_label" ? (
            <canvas ref={outCanvasRef} className="mt-2 w-full rounded border border-zinc-300 bg-zinc-950" />
          ) : null}
          <pre className="mt-3 max-h-72 overflow-auto rounded bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-100">
            {JSON.stringify(info, null, 2)}
          </pre>
        </section>
      </div>

      <p className="mt-6 max-w-3xl text-xs text-zinc-500">
        Parity: browser ports of{" "}
        <span className="font-mono">../VLM-DENTAL/dental_agent/tools/*.py</span>, tested bit-exact
        against <span className="font-mono">fixtures/goldens/m4_tools.json</span> (16 tests over
        PIL/cv2-generated goldens). denoise previews at ≤720px for speed; actual kernel parameters
        are shown in the result JSON.
      </p>
    </div>
  );
}

