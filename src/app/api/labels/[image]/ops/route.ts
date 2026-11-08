import { resolveLabelDeps } from "@/shared/labels/deps";
import * as h from "@/shared/labels/handlers";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const labelOpsGuard = createSecurityGuard({ key: "labels:ops", max: 100, windowMs: 60_000 });

export async function POST(req: Request, ctx: { params: Promise<{ image: string }> }) {
  const guard = await labelOpsGuard.check(req);
  if (!guard.ok) return guard.response;
  const d = await resolveLabelDeps();
  if (d instanceof Response) return d;
  const { image } = await ctx.params;
  const res = await h.postOps(req, d, image);
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
