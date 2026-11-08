import { resolveUserDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/user-handlers";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const jobCreateGuard = createSecurityGuard({ key: "jobs:create", max: 30, windowMs: 60_000 });

export async function POST(req: Request) {
  const guard = await jobCreateGuard.check(req);
  if (!guard.ok) return guard.response;
  const d = await resolveUserDeps();
  if (d instanceof Response) return d;
  const res = await h.createJob(req, d);
  Object.entries(securityHeaders()).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set("x-ratelimit-remaining", String(guard.rateLimit.remaining));
  return res;
}

export async function GET(req: Request) {
  const d = await resolveUserDeps();
  if (d instanceof Response) return d;
  const res = await h.listJobs(req, d);
  Object.entries(securityHeaders()).forEach(([k, v]) => res.headers.set(k, v));
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
