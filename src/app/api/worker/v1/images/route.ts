import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  return h.listImages(req, d);
}
