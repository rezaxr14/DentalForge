import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const workerPresignGuard = createSecurityGuard({ key: "worker:presign", max: 30, windowMs: 60_000 });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await workerPresignGuard.check(req);
  if (!guard.ok) return guard.response;
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  const { id } = await ctx.params;
  const res = await h.presignArtifact(req, d, id);
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
