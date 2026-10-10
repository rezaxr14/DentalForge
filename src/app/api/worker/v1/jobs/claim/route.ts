import { resolveWorkerDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/worker-handlers";

export const dynamic = "force-dynamic";
// Long-poll: stay inside the platform function limit (claim waits at most 20 s).
export const maxDuration = 30;

export async function POST(req: Request) {
  const d = await resolveWorkerDeps();
  if (d instanceof Response) return d;
  return h.claim(req, d);
}
