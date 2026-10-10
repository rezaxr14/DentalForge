import { capabilities, tryGetEnv } from "@/shared/config/env";
import { CONTRACT_VERSION } from "@/shared/contracts/worker";
import { isDegradedStore, selectOrgStore } from "@/shared/db";
import { getStorageAdapter } from "@/shared/jobs/deps";

export const dynamic = "force-dynamic";

/**
 * Uptime/diagnostic probe (plan §12.6). Reports which optional services this
 * deployment actually has. No secrets, no per-org data, never throws:
 *   - a dead database is a `degraded` answer (200: the app still serves),
 *   - an insecure/incomplete production config is `misconfigured` (503) and
 *     names the offending VARIABLES (never their values).
 */
export async function GET() {
  const parsed = tryGetEnv();
  if (!parsed.ok) {
    return Response.json(
      { status: "misconfigured", contractVersion: CONTRACT_VERSION, problems: parsed.problems },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const env = parsed.env;
  const caps = capabilities(env);
  let db: "up" | "down" | "unconfigured" = caps.db ? "up" : "unconfigured";
  if (caps.db) {
    try {
      db = isDegradedStore(await selectOrgStore()) ? "down" : "up";
    } catch {
      db = "down";
    }
  }
  let storage = "unavailable";
  try {
    storage = getStorageAdapter().provider;
  } catch {
    /* reported as unavailable */
  }
  return Response.json(
    {
      status: db === "down" ? "degraded" : "ok",
      contractVersion: CONTRACT_VERSION,
      db,
      redis: caps.redis ? "configured" : "absent",
      storage,
      workerMode: env.WORKER_MODE,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
