/**
 * Server wiring for the job/worker surface. Everything here is resolved per
 * request and degrades to a problem+json instead of throwing:
 *   - worker endpoints need a durable store; with the in-memory fallback they
 *     answer 503 + Retry-After so a polling worker keeps retrying (a 401 would
 *     make it think its token is bad and stop).
 *   - user endpoints resolve the session actor; signed-out/offline → null.
 */
import { capabilities, getEnv } from "@/shared/config/env";
import { selectOrgStore, isDegradedStore } from "@/shared/db";
import { LocalStorageAdapter, R2StorageAdapter, type StorageAdapter } from "@/shared/storage/adapter";
import { problem } from "./problem";
import type { WorkerDeps } from "./worker-handlers";
import type { Actor, UserDeps } from "./user-handlers";

const G = globalThis as unknown as { __tfStorage?: StorageAdapter };

export function getStorageAdapter(): StorageAdapter {
  if (!G.__tfStorage) {
    const env = getEnv();
    G.__tfStorage = capabilities(env).r2 ? new R2StorageAdapter(env.R2_BUCKET ?? "") : new LocalStorageAdapter();
  }
  return G.__tfStorage;
}

export async function resolveWorkerDeps(): Promise<WorkerDeps | Response> {
  const store = await selectOrgStore();
  if (isDegradedStore(store)) {
    return problem(503, "unavailable", "Worker API is unavailable", "The database is unreachable; retry shortly.", {}, { "retry-after": "15" });
  }
  return { store, storage: getStorageAdapter() };
}

export async function getActor(): Promise<Actor | null> {
  // Lazy on purpose: Better Auth reads (and, in production, validates) the env at
  // IMPORT time. Importing it here eagerly made every route that touches deps —
  // /api/health, all worker endpoints — fail to even load on a misconfigured
  // deploy, and made worker endpoints pay for an auth stack they never use.
  const { getSession } = await import("@/shared/auth/session");
  const session = await getSession();
  const userId = session?.user.id;
  const orgId = session?.session.activeOrganizationId;
  if (!userId || typeof orgId !== "string" || orgId.length === 0) return null;
  const store = await selectOrgStore();
  const m = await store.membership(userId, orgId);
  return m ? { userId, orgId, role: m.role } : null;
}

export async function resolveUserDeps(): Promise<UserDeps | Response> {
  const store = await selectOrgStore();
  if (isDegradedStore(store)) {
    return problem(503, "unavailable", "Jobs are unavailable", "The database is unreachable; retry shortly.", {}, { "retry-after": "15" });
  }
  return { store, actor: await getActor(), workerMode: getEnv().WORKER_MODE };
}
