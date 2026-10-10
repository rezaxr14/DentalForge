import { buildWorkerOpenApi } from "@/shared/contracts/openapi";

export const dynamic = "force-static";

export function GET() {
  return Response.json(buildWorkerOpenApi(), { headers: { "cache-control": "public, max-age=300" } });
}
