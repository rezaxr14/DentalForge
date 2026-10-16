import { resolveLabelDeps } from "@/shared/labels/deps";
import * as h from "@/shared/labels/handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ image: string }> }) {
  const d = await resolveLabelDeps();
  if (d instanceof Response) return d;
  const { image } = await ctx.params;
  return h.postTransition(req, d, image);
}
