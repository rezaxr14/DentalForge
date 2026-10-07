import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getEnv } from "@/shared/config/env";
import * as schema from "./schema";

/**
 * Postgres client (plan §9.4: DB is one of the two boot-critical services).
 * Pool is a module singleton re-created per server process; the global cache
 * survives Next.js dev HMR reloads so we never leak pools.
 */
const g = globalThis as unknown as { __tfPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!g.__tfPool) {
    g.__tfPool = new pg.Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
    });
  }
  return g.__tfPool;
}

let cached: NodePgDatabase<typeof schema> | undefined;

export function getPgDb(): NodePgDatabase<typeof schema> {
  if (!cached) cached = drizzle(getPool(), { schema });
  return cached;
}

export type Db = NodePgDatabase<typeof schema>;
