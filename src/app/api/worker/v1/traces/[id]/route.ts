import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  const { id } = await ctx.params;
  return h.getWorkerTrace(req, d, id);
}
