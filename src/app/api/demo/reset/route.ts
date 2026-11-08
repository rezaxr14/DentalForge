import { resolveUserDeps } from "@/shared/jobs/deps";
import { getPgDb } from "@/shared/db/pg";
import * as s from "@/shared/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const cronSecret = process.env.CRON_SECRET;
const demoResetGuard = createSecurityGuard({ key: "demo:reset", max: 5, windowMs: 24 * 60 * 60 * 1000 });

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const guard = await demoResetGuard.check(req);
  if (!guard.ok) return guard.response;

  const d = await resolveUserDeps();
  if (d instanceof Response) return d;
  if (!d.actor) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const db = getPgDb();
  const orgId = d.actor.orgId;

  try {
    const traces = await db.select({ id: s.traces.id }).from(s.traces).where(eq(s.traces.orgId, orgId));
    const traceIds = traces.map((t) => t.id);
    const images = await db.select({ id: s.images.id }).from(s.images).where(eq(s.images.orgId, orgId));
    const imageIds = images.map((i) => i.id);
    const evalRuns = await db.select({ id: s.evalRuns.id }).from(s.evalRuns).where(eq(s.evalRuns.orgId, orgId));
    const evalRunIds = evalRuns.map((e) => e.id);

    if (traceIds.length) {
      await db.delete(s.toolCalls).where(and(eq(s.toolCalls.orgId, orgId), inArray(s.toolCalls.turnId, traceIds)));
      await db.delete(s.traceTurns).where(and(eq(s.traceTurns.orgId, orgId), inArray(s.traceTurns.traceId, traceIds)));
      await db.delete(s.traces).where(and(eq(s.traces.orgId, orgId), inArray(s.traces.id, traceIds)));
    }
    if (evalRunIds.length) {
      await db.delete(s.evalCases).where(and(eq(s.evalCases.orgId, orgId), inArray(s.evalCases.runId, evalRunIds)));
      await db.delete(s.evalRuns).where(and(eq(s.evalRuns.orgId, orgId), inArray(s.evalRuns.id, evalRunIds)));
    }
    if (imageIds.length) {
      await db.delete(s.images).where(and(eq(s.images.orgId, orgId), inArray(s.images.id, imageIds)));
    }

    return new Response(
      JSON.stringify({ ok: true, deleted: { traces: traceIds.length, evalRuns: evalRunIds.length, images: imageIds.length } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (e) {
    console.error("[demo:reset]", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}