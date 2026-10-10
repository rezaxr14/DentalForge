import { resolveUserDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/user-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const d = await resolveUserDeps();
  if (d instanceof Response) return d;
  const { id } = await ctx.params;
  return h.cancelJob(req, d, id);
}
