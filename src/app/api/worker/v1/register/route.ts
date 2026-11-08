import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const workerRegisterGuard = createSecurityGuard({ key: "worker:register", max: 10, windowMs: 60_000 });
const workerClaimGuard = createSecurityGuard({ key: "worker:claim", max: 60, windowMs: 60_000 });
const workerHeartbeatGuard = createSecurityGuard({ key: "worker:heartbeat", max: 120, windowMs: 60_000 });
const workerEventsGuard = createSecurityGuard({ key: "worker:events", max: 60, windowMs: 60_000 });
const workerCompleteGuard = createSecurityGuard({ key: "worker:complete", max: 60, windowMs: 60_000 });
const workerFailGuard = createSecurityGuard({ key: "worker:fail", max: 60, windowMs: 60_000 });
const workerPresignGuard = createSecurityGuard({ key: "worker:presign", max: 30, windowMs: 60_000 });
const workerIngestTracesGuard = createSecurityGuard({ key: "worker:ingest:traces", max: 30, windowMs: 60_000 });
const workerIngestEvalGuard = createSecurityGuard({ key: "worker:ingest:eval", max: 30, windowMs: 60_000 });
const workerIngestMetricsGuard = createSecurityGuard({ key: "worker:ingest:metrics", max: 60, windowMs: 60_000 });
const workerModelsRegisterGuard = createSecurityGuard({ key: "worker:models:register", max: 10, windowMs: 60_000 });

export async function POST(req: Request) {
  const guard = await workerRegisterGuard.check(req);
  if (!guard.ok) return guard.response;
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  const res = await h.register(req, d);
  Object.entries(securityHeaders()).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set("x-ratelimit-remaining", String(guard.rateLimit.remaining));
  return res;
}

function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}
