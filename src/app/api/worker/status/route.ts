import { tryGetEnv } from "@/shared/config/env";
import { emptySnapshot, loadWorkerSnapshot } from "@/features/capability";
import { selectOrgStore, isDegradedStore } from "@/shared/db";
import { getActor } from "@/shared/jobs/deps";

export const dynamic = "force-dynamic";

/** Session-aware worker status for the header pill. Never errors: offline is an answer. */
export async function GET() {
  const parsed = tryGetEnv();
  const mode = parsed.ok ? parsed.env.WORKER_MODE : "off";
  const headers = { "cache-control": "no-store" };
  if (!parsed.ok) return Response.json(emptySnapshot(mode, false, "db-unavailable"), { headers });
  try {
    const store = await selectOrgStore();
    const dbAvailable = !isDegradedStore(store);
    const actor = dbAvailable ? await getActor() : null;
    const snap = await loadWorkerSnapshot(actor ? store.scoped(actor.orgId) : null, mode, dbAvailable);
    return Response.json(snap, { headers });
  } catch {
    return Response.json(emptySnapshot(mode, false, "db-unavailable"), { headers });
  }
}
