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
    const isCI = process.env.CI === "true";
    const connectionString = env.DATABASE_URL;
    
    // Parse SSL mode from connection string if present
    const sslModeMatch = connectionString.match(/sslmode=([^&]+)/);
    const urlSslMode = sslModeMatch ? sslModeMatch[1] : undefined;
    
    // In CI, use rejectUnauthorized: false since CI Postgres doesn't have SSL
    // In production with explicit sslmode, respect the URL setting
    // Otherwise in production, require valid certificates
    let ssl: pg.PoolConfig["ssl"] = false;
    if (isCI) {
      ssl = { rejectUnauthorized: false };
    } else if (isProd) {
      if (urlSslMode === "require" || urlSslMode === "verify-ca" || urlSslMode === "verify-full") {
        ssl = { rejectUnauthorized: true };
      } else if (urlSslMode === "prefer" || urlSslMode === "allow") {
        ssl = { rejectUnauthorized: false };
      } else {
        // Default production behavior: require valid certificates
        ssl = { rejectUnauthorized: true };
      }
    }
    
    g.__tfPool = new pg.Pool({
      connectionString,
      // Lower pool for serverless (prevents connection exhaustion under load).
      max: isProd ? 3 : 10,
      // Fail fast: a blackholed DB host must degrade the app, not hang requests.
      connectionTimeoutMillis: 3000,
      // Idle timeout to return connections to pool promptly.
      idleTimeoutMillis: isProd ? 10_000 : 30_000,
      // Statement timeout to prevent runaway queries.
      statement_timeout: 30_000,
      ssl,
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
