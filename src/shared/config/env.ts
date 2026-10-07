/**
 * Env validation (plan §9.4 rule 4, §14).
 *
 * The app boots with ONLY database + auth variables. Missing Redis →
 * polling mode; missing storage creds → local adapter; WORKER_MODE defaults
 * to `off`. Nothing here throws for optional services — callers branch on
 * `capabilities` instead (capability ladder, §9).
 */
import { z } from "zod";

const EnvShape = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required").default("postgresql://traceforge:traceforge@localhost:5433/traceforge"),
  BETTER_AUTH_SECRET: z.string().default("dev-only-secret-min-32-chars-0123456789ab"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  INVITE_SIGNING_SECRET: z.string().default("dev-only-invite-secret"),
  STORAGE_PROVIDER: z.enum(["r2", "blob", "local"]).default("local"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  WORKER_MODE: z.enum(["off", "mock", "live"]).default("off"),
  DEMO_ORG_SLUG: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppEnv = z.infer<typeof EnvShape>;

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cached) cached = EnvShape.parse(process.env);
  return cached;
}

/** For tests: parse an explicit record instead of process.env. */
export function parseEnv(record: Record<string, string | undefined>): AppEnv {
  return EnvShape.parse(record);
}

export interface Capabilities {
  db: boolean;
  redis: boolean;
  r2: boolean;
  oauthGithub: boolean;
  oauthGoogle: boolean;
  workerMode: "off" | "mock" | "live";
  demoOrg: boolean;
}

/** Derived availability — graceful degradation decisions branch on this. */
export function capabilities(env: AppEnv = getEnv()): Capabilities {
  return {
    db: env.DATABASE_URL.length > 0,
    redis: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
    r2:
      env.STORAGE_PROVIDER === "r2" &&
      Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET),
    oauthGithub: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    oauthGoogle: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    workerMode: env.WORKER_MODE,
    demoOrg: Boolean(env.DEMO_ORG_SLUG),
  };
}

/** Worker-online status derivation (plan §9.3). Pure function of last heartbeat. */
export type WorkerStatus = "online" | "degraded" | "offline";

export function workerStatus(lastHeartbeatAt: Date | null, now = new Date()): WorkerStatus {
  if (!lastHeartbeatAt) return "offline";
  const ageMs = now.getTime() - lastHeartbeatAt.getTime();
  if (ageMs <= 30_000) return "online";
  if (ageMs <= 120_000) return "degraded";
  return "offline";
}
