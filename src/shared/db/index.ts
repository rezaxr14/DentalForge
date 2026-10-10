/**
 * Repository layer selection (plan §9 capability ladder / M6, hardened in M8).
 *
 * The default selector probes Postgres:
 *   - reachable      → DrizzleOrgStore (plan §5.2 scoped(orgId) SQL isolation)
 *   - unreachable    → MemoryStore    (graceful degradation; demo/offline mode)
 *
 * M8 hardening: a *failed* probe is cached only briefly (`negativeTtlMs`).
 * Before, one slow Neon cold start pinned a serverless instance to the
 * in-memory store for its whole lifetime — "connect the backend later" never
 * took effect until redeploy. A *successful* probe is cached permanently. The
 * selector lives on `globalThis` so every route bundle shares one instance
 * (and one MemoryStore) instead of each bundle re-probing.
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

export interface StoreSelectorOptions {
  probe: StoreProbe;
  now?: () => number;
  /** How long a failed probe is trusted before re-probing (default 15 s). */
  negativeTtlMs?: number;
  makeDurable?: () => OrgStore;
}

export interface StoreSelector {
  get(): Promise<OrgStore>;
  reset(): void;
}

export function createStoreSelector(opts: StoreSelectorOptions): StoreSelector {
  const now = opts.now ?? Date.now;
  const ttl = opts.negativeTtlMs ?? 15_000;
  const makeDurable = opts.makeDurable ?? (() => new DrizzleOrgStore(getPgDb()));
  let durable: OrgStore | null = null;
  let memory: MemoryStore | null = null;
  let failedAt = -Infinity;
  let inflight: Promise<OrgStore> | null = null;

  const attempt = async (): Promise<OrgStore> => {
    try {
      await opts.probe();
      durable = makeDurable();
      return durable;
    } catch {
      failedAt = now();
      memory ??= new MemoryStore(); // keep ONE memory store across failed probes
      return memory;
    }
  };

  return {
    async get() {
      if (durable) return durable;
      if (memory && now() - failedAt < ttl) return memory;
      inflight ??= attempt().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    reset() {
      durable = null;
      memory = null;
      failedAt = -Infinity;
      inflight = null;
    },
  };
}

const G = globalThis as unknown as { __tfStoreSelector?: StoreSelector };

function defaultSelector(): StoreSelector {
  G.__tfStoreSelector ??= createStoreSelector({ probe: pingDatabase });
  return G.__tfStoreSelector;
}

/**
 * Returns the org store for this process. Pass `probe` (tests) to override the
 * default `SELECT 1` health check; injected probes bypass the shared selector.
 */
export function selectOrgStore(probe?: StoreProbe): Promise<OrgStore> {
  if (!probe) return defaultSelector().get();
  return (async () => {
    try {
      await probe();
      return new DrizzleOrgStore(getPgDb());
    } catch {
      return new MemoryStore();
    }
  })();
}

/** True when the store is the in-memory fallback (the database is unreachable). */
export function isDegradedStore(store: OrgStore): boolean {
  return store instanceof MemoryStore;
}

/** Test hook: forget the cached selection (e.g. after closing the pool). */
export function resetOrgStoreSelection(): void {
  defaultSelector().reset();
}
