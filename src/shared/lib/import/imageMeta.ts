/**
 * M7 importer — image source resolution + metadata (plan §4.1, §5.3).
 *
 * Read-only against the owner's local VLM-DENTAL checkout. Resolves
 * `(dataset, image_id)` to a file (NEVER `image_path`, plan §4.3) and reads
 * dimensions straight from the file header (PNG IHDR / JPEG SOF) so no image
 * decoding dependency is needed for import.
 */
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ImageSource {
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** Local (dataset, image_id) → file path. Verified against the real tree. */
export function resolveImagePath(
  dataRoot: string,
  dataset: string,
  imageId: number,
): string | null {
  const dir =
    dataset === "tufts"
      ? join(dataRoot, "Tufts", "Radiographs")
      : join(dataRoot, "dentex", "DENTEX", "training_data", "quadrant-enumeration-disease", "xrays");
  const file = dataset === "tufts" ? `${imageId}.JPG` : `train_${imageId}.png`;
  const path = join(dir, file);
  return existsSync(path) ? path : null;
}

/** Read PNG width/height from IHDR (bytes 16–23, big-endian). */
function pngSize(path: string): { width: number; height: number } | null {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(24);
    if (readSync(fd, buf, 0, 24, 0) !== 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** Scan JPEG markers for the first SOF (frame header) → dims. */
function jpegSize(path: string): { width: number; height: number } | null {
  const buf = readFileSync(path);
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = buf[off + 1]!;
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

/** Full metadata for one source image (dims + content hash, plan §5.3). */
export function readImageSource(path: string): ImageSource {
  const dims = /\.png$/i.test(path) ? pngSize(path) : jpegSize(path);
  const bytes = statSync(path).size;
  return {
    path,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    bytes,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}
