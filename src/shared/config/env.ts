/**
 * Env validation (plan §9.4 rule 4, §14).
 *
 * The app boots with ONLY database + auth variables. Missing Redis →
 * polling mode; missing storage creds → local adapter; WORKER_MODE defaults
 * to `off`. Nothing here throws for optional services — callers branch on
 * `capabilities` instead (capability ladder, §9).
 *
 * Production hardening (Claude review): the dev defaults below are COMMITTED
 * TO A PUBLIC REPO, so in production they are publicly known secrets — a
 * deploy that forgot BETTER_AUTH_SECRET/INVITE_SIGNING_SECRET would let
 * anyone forge sessions or invites. When NODE_ENV=production the three
 * critical variables must be set explicitly and must not be one of the known
 * public values, otherwise parsing FAILS AT STARTUP.
 */
import { z } from "zod";

/** Dev-only defaults — fine locally, never acceptable in production. */
const DEV_DATABASE_URL = "postgresql://traceforge:traceforge@localhost:5433/traceforge";
const DEV_BETTER_AUTH_SECRET = "dev-only-secret-min-32-chars-0123456789ab";
const DEV_INVITE_SIGNING_SECRET = "dev-only-invite-secret";
const DEV_BETTER_AUTH_URL = "http://localhost:3000";

/**
 * Values that are publicly known because this repository publishes them
 * (dev defaults above + the placeholders in .env.example). Explicitly setting
 * one of these in production is rejected — it is equivalent to no secret.
 */
export const PUBLIC_KNOWN_SECRETS: ReadonlySet<string> = new Set([
  DEV_BETTER_AUTH_SECRET,
  DEV_INVITE_SIGNING_SECRET,
  "change-me-min-32-characters-please",
  "change-me-invite-secret",
]);

const EnvShape = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required").default(DEV_DATABASE_URL),
  BETTER_AUTH_SECRET: z.string().default(DEV_BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: z.string().default(DEV_BETTER_AUTH_URL),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  INVITE_SIGNING_SECRET: z.string().default(DEV_INVITE_SIGNING_SECRET),
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

export type AppEnv = z.infer<typeof EnvShape> & {
  /**
   * True only when DATABASE_URL was EXPLICITLY provided. The dev default URL
   * must not make `capabilities().db` claim a database exists — with the
   * default it detects nothing (Claude review).
   */
  dbConfigured: boolean;
};

/** Treat empty strings as unset (a blank env line is an absence, not a value). */
function normalizeRecord(record: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== "") out[key] = value;
  }
  return out;
}

/** Production violations of the secrets guard (plan §14: all "yes" rows). */
function productionViolations(record: Record<string, string | undefined>): string[] {
  const problems: string[] = [];

  const explicit = (key: "DATABASE_URL" | "BETTER_AUTH_URL" | "BETTER_AUTH_SECRET" | "INVITE_SIGNING_SECRET") => {
    if (!record[key]) problems.push(`${key} must be set explicitly in production (it has an unsafe dev default)`);
  };
  explicit("DATABASE_URL");
  explicit("BETTER_AUTH_URL");
  explicit("BETTER_AUTH_SECRET");
  explicit("INVITE_SIGNING_SECRET");

  const authSecret = record.BETTER_AUTH_SECRET;
  if (authSecret) {
    if (PUBLIC_KNOWN_SECRETS.has(authSecret)) {
      problems.push("BETTER_AUTH_SECRET is a publicly known value committed to this repo; generate a unique secret");
    } else if (authSecret.length < 32) {
      problems.push("BETTER_AUTH_SECRET must be at least 32 characters in production");
    }
  }

  const inviteSecret = record.INVITE_SIGNING_SECRET;
  if (inviteSecret) {
    if (PUBLIC_KNOWN_SECRETS.has(inviteSecret)) {
      problems.push("INVITE_SIGNING_SECRET is a publicly known value committed to this repo; generate a unique secret");
    } else if (inviteSecret.length < 16) {
      problems.push("INVITE_SIGNING_SECRET must be at least 16 characters in production");
    }
  }

  return problems;
}

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** For tests: parse an explicit record instead of process.env. */
export function parseEnv(record: Record<string, string | undefined>): AppEnv {
  const normalized = normalizeRecord(record);
  const env = EnvShape.parse(normalized);
  if (env.NODE_ENV === "production") {
    const problems = productionViolations(normalized);
    if (problems.length > 0) {
      throw new Error(
        `[env] Refusing to start with an insecure production configuration:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\nSet the variables in your deployment (see .env.example).`,
      );
    }
  }
  return { ...env, dbConfigured: Boolean(normalized.DATABASE_URL) };
}

/**
 * Diagnostic-safe env check for health/status endpoints: never throws and never
 * echoes a value — only which variables are wrong (the guard's messages name
 * variables, not their contents).
 */
export function tryGetEnv(): { ok: true; env: AppEnv } | { ok: false; problems: string[] } {
  try {
    return { ok: true, env: getEnv() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lines = msg
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter((l) => l && !l.startsWith("[env]") && !l.startsWith("Set the variables"));
    return { ok: false, problems: lines.length > 0 ? lines : ["environment failed validation"] };
  }
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
    // Only an EXPLICITLY configured database counts: the dev-default URL must
    // not claim a database exists (it detects nothing).
    db: env.dbConfigured,
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
