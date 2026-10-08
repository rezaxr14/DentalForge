/**
 * Repository layer selection (plan §9 capability ladder / M6).
 *
 * `selectOrgStore()` probes Postgres once and caches the decision:
 *   - reachable      → DrizzleOrgStore (plan §5.2 scoped(orgId) SQL isolation)
 *   - unreachable    → MemoryStore    (graceful degradation; demo/offline mode)
 *
 * Features must go through the returned `OrgStore` — direct `db.select()`
 * calls in features stay lint-forbidden (§5.2).
 */
import { MemoryStore } from "./memory";
import { getPool, getPgDb } from "./pg";
import type { OrgStore } from "./repos";
import { DrizzleOrgStore } from "./repositories";

export type StoreProbe = () => Promise<void>;

async function pingDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

let selection: Promise<OrgStore> | null = null;

/**
 * Returns the org store for this process. Pass `probe` (tests) to override the
 * default `SELECT 1` health check; injected probes bypass the cache.
 */
export function selectOrgStore(probe?: StoreProbe): Promise<OrgStore> {
  if (!probe) {
    if (!selection) selection = selectOrgStore(pingDatabase);
    return selection;
  }
  return (async () => {
    try {
      await probe();
      return new DrizzleOrgStore(getPgDb());
    } catch {
      return new MemoryStore();
    }
  })();
}

/** Test hook: forget the cached selection (e.g. after closing the pool). */
export function resetOrgStoreSelection(): void {
  selection = null;
}
