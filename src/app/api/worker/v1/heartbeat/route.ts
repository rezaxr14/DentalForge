import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  return h.heartbeat(req, d);
}
