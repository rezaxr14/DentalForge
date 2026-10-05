/**
 * M4 port: pure-geometry + data tools.
 * Sources: dental_agent/tools/{zoom_crop,nudge,fdi}.py
 * Pixel-exact parity via fixtures/goldens/m4_tools.json.
 */

export type Bbox4 = [x: number, y: number, w: number, h: number];

/** Port of tool_zoom_crop geometry: returns the crop rect (clamped). */
export function zoomCropRect(
  imgW: number, imgH: number, bbox: Bbox4,
  paddingFrac = 0.25, contextPadding?: number,
): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const pad = contextPadding ?? paddingFrac;
  const [x, y, w, h] = bbox;
  const padX = Math.max(w * pad, 50);
  const padY = Math.max(h * pad, 50);
  const left = Math.max(0, x - padX);
  const top = Math.max(0, y - padY);
  const right = Math.min(imgW, x + w + padX);
  const bottom = Math.min(imgH, y + h + padY);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Port of box_out_of_bounds. */
export function boxOutOfBounds(bbox: Bbox4, imgW: number, imgH: number): boolean {
  const [x, y, w, h] = bbox;
  return x < 0 || y < 0 || x + w > imgW || y + h > imgH;
}

export interface NudgeResult { bbox?: Bbox4; error?: string; note?: string }

/** Port of tool_nudge_crop. */
export function nudgeCrop(
  imgW: number, imgH: number, bbox: number[],
  dxFrac = 0, dyFrac = 0, scale = 1,
): NudgeResult {
  if (!bbox || bbox.length !== 4) return { error: "bbox must be [x, y, w, h]." };
  const [x, y, w, h] = bbox as Bbox4;
  if (w <= 0 || h <= 0) return { error: "bbox width and height must be positive." };
  const cx = x + w / 2 + dxFrac * w;
  const cy = y + h / 2 + dyFrac * h;
  const sc = Math.max(0.1, scale);
  const newW = Math.min(w * sc, imgW);
  const newH = Math.min(h * sc, imgH);
  const nx = Math.max(0, Math.min(cx - newW / 2, imgW - newW));
  const ny = Math.max(0, Math.min(cy - newH / 2, imgH - newH));
  const round1 = (v: number): number => Math.round(v * 10) / 10;
  return {
    bbox: [round1(nx), round1(ny), round1(newW), round1(newH)],
    note: "Call zoom_crop with this bbox to view the adjusted region.",
  };
}
