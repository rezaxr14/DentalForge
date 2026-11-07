/**
 * Stored tool-image artifacts for one trace (§9 ladder, rung 1).
 *
 * Public demo assets are served straight from `public/`; everything else goes
 * through the storage adapter. Any failure yields the honest placeholder, so a
 * single bad key never hides the rest of the trace.
 */
import type { VerifiedTraceT } from "@/shared/contracts/traces";
import { getStorageAdapter } from "@/shared/jobs/deps";
import type { ArtifactImageRef, DataSource } from "./datasource";
import { publicImageUrl } from "./image-url";

export interface ToolImageInfo {
  url: string;
  provenance: ArtifactImageRef["provenance"];
}

export async function loadToolImages(
  source: DataSource,
  trace: VerifiedTraceT,
): Promise<Map<string, ToolImageInfo>> {
  const ids = trace.turns
    .flatMap((t) => t.tool_calls_this_turn ?? [])
    .map((c) => (c as { artifact_id?: string }).artifact_id)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const out = new Map<string, ToolImageInfo>();
  if (ids.length === 0) return out;
  let refs: ArtifactImageRef[];
  try {
    refs = await source.getArtifactImages(ids);
  } catch {
    return out;
  }
  if (refs.length === 0) return out;
  let storage: ReturnType<typeof getStorageAdapter> | null = null;
  try {
    storage = getStorageAdapter();
  } catch {
    storage = null;
  }
  for (const a of refs) {
    const pub = publicImageUrl(a.storageKey);
    if (pub) {
      out.set(a.id, { url: pub, provenance: a.provenance });
      continue;
    }
    if (!storage) continue;
    try {
      out.set(a.id, {
        url: await storage.presignDownload(a.storageKey, 600),
        provenance: a.provenance,
      });
    } catch {
      // One bad key must not hide the rest — this call shows its placeholder.
    }
  }
  return out;
}
