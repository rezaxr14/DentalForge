/**
 * Server-side worker snapshot for pages that resolve the ladder during render
 * (plan §9.3, same wiring as /status and /api/worker/status). Never throws:
 * any failure degrades to an honest `offline` snapshot (plan §9 rule 4).
 *
 * Kept out of `index.ts` on purpose — it pulls in the database and auth deps
 * and must never reach a client bundle.
 */
import { tryGetEnv } from "@/shared/config/env";
import { isDegradedStore, selectOrgStore } from "@/shared/db";
import { getActor } from "@/shared/jobs/deps";
import { emptySnapshot, loadWorkerSnapshot, type WorkerSnapshot } from "./service";
import type { WorkerMode } from "./service";

export async function loadPageSnapshot(): Promise<WorkerSnapshot> {
  try {
    const parsed = tryGetEnv();
    if (!parsed.ok) return emptySnapshot("off", false, "db-unavailable");
    const mode: WorkerMode = parsed.env.WORKER_MODE;
    const store = await selectOrgStore();
    const dbAvailable = !isDegradedStore(store);
    const actor = dbAvailable ? await getActor() : null;
    return await loadWorkerSnapshot(actor ? store.scoped(actor.orgId) : null, mode, dbAvailable);
  } catch {
    return emptySnapshot("off", false, "db-unavailable");
  }
}
