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
    const env = getEnv();
    const isProd = env.NODE_ENV === "production";
    g.__tfPool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      // Lower pool for serverless (prevents connection exhaustion under load).
      max: isProd ? 3 : 10,
      // Fail fast: a blackholed DB host must degrade the app, not hang requests.
      connectionTimeoutMillis: 3000,
      // Idle timeout to return connections to pool promptly.
      idleTimeoutMillis: isProd ? 10_000 : 30_000,
      // Statement timeout to prevent runaway queries.
      statement_timeout: 30_000,
      // SSL with certificate verification in production.
      ssl: isProd
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
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
