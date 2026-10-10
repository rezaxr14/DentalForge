import { resolveUserDeps } from "@/shared/jobs/deps";
import * as h from "@/shared/jobs/user-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const d = await resolveUserDeps();
  return d instanceof Response ? d : h.createJob(req, d);
}

export async function GET(req: Request) {
  const d = await resolveUserDeps();
  return d instanceof Response ? d : h.listJobs(req, d);
}
