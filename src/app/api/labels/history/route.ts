import { resolveLabelDeps } from "@/shared/labels/deps";
import * as h from "@/shared/labels/handlers";

export const dynamic = "force-dynamic";

/** Read-only decision history of the org's sets (the Review board). */
export async function GET() {
  const d = await resolveLabelDeps();
  if (d instanceof Response) return d;
  return h.listHistory(d);
}
