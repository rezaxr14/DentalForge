import { notImplemented } from "@/shared/jobs/worker-handlers";

export const dynamic = "force-dynamic";

// Documented in contract v1 §10.1; scheduled after M8 (ADR-0009).
export async function POST() {
  return notImplemented("POST /api/worker/v1/models/register");
}
