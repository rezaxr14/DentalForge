import { resolveLabelDeps } from "@/shared/labels/deps";
import * as h from "@/shared/labels/handlers";

export const dynamic = "force-dynamic";

/** Read-only list of the org's opened sets (Review, Export, queue). */
export async function GET() {
  const d = await resolveLabelDeps();
  if (d instanceof Response) return d;
  return h.listSets(d);
}
