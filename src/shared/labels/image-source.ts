/**
 * Which stored image a LabelForge image id (the fixture id in the URL, "1".."5") is.
 * Server-side only: dimensions and licence come from the fixture, never from the request, because the dimensions
 * are what the server validates human boxes against (ADR-0019 decision 1).
 */
import type { OpenImageInput } from "@/shared/db/repos";
import { getLabel } from "@/shared/lib/fixtures";

const IMAGE_ID = /^[a-z0-9_]+$/i;
const DENTEX_FILE = /^train_(\d+)\.png$/;

export function resolveFixtureImage(id: string): OpenImageInput | null {
  if (!IMAGE_ID.test(id)) return null;
  try {
    const f = getLabel(id);
    const m = DENTEX_FILE.exec(f.source_file);
    if (f.dataset !== "dentex" || !m) return null;
    const sourceImageId = Number(m[1]);
    return {
      source: "dentex",
      datasetName: "dentex",
      licenseNote: f.license,
      sourceImageId,
      // Same convention as the importer's unresolved files (`missing:<dataset>:<id>`): no file content is read here.
      contentHash: `fixture:dentex:${sourceImageId}`,
      width: f.width,
      height: f.height,
      storageKey: f.image_path.replace(/^\//, "public/"),
      split: "train",
    };
  } catch {
    return null; // unknown id (no such fixture file) or a fixture that fails its contract
  }
}
