import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const workerFailGuard = createSecurityGuard({ key: "worker:fail", max: 60, windowMs: 60_000 });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await workerFailGuard.check(req);
  if (!guard.ok) return guard.response;
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  const { id } = await ctx.params;
  const res = await h.fail(req, d, id);
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
