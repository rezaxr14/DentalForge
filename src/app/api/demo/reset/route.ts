import { and, eq, inArray, ne } from "drizzle-orm";
import { getPgDb } from "@/shared/db/pg";
import * as s from "@/shared/db/schema";
import { createSecurityGuard } from "@/shared/lib/middleware/security";

export const dynamic = "force-dynamic";

const demoResetGuard = createSecurityGuard({ key: "demo:reset", max: 5, windowMs: 24 * 60 * 60 * 1000 });

const RETRY_AFTER_S = 30;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unavailable(): Response {
  return new Response(JSON.stringify({ error: "Database unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": String(RETRY_AFTER_S) },
  });
}

/**
 * `POST /api/demo/reset` — Vercel Cron, once a day.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` for a cron job when
 * `CRON_SECRET` is set. A missing secret is a misconfiguration, so the route
 * fails closed (401) rather than running unauthenticated.
 *
 * The route removes what visitors created in the demo org (annotation sets,
 * annotations, review tasks and decisions, predictions, queue scores, agreement
 * stats, exports, audit rows, invites, worker tokens, and the demo-only users)
 * and keeps the seeded rows: datasets, images, traces, eval runs and cases,
 * models and artifacts. Running it twice is a no-op. It does not re-seed; the
 * committed bundle is re-applied with `pnpm demo:seed --reset` when the data
 * itself changes.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, 401);

  const guard = await demoResetGuard.check(req);
  if (!guard.ok) return guard.response;

  const slug = process.env.DEMO_ORG_SLUG ?? "demo";
  const db = getPgDb();

  try {
    const org = (
      await db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, slug)).limit(1)
    )[0];
    if (!org) return json({ ok: true, slug, skipped: "no demo org" });
    const orgId = org.id;

    const members = await db
      .select({ userId: s.memberships.userId })
      .from(s.memberships)
      .where(eq(s.memberships.organizationId, orgId));
    const memberIds = members.map((m) => m.userId);
    const elsewhere = memberIds.length
      ? await db
          .select({ userId: s.memberships.userId })
          .from(s.memberships)
          .where(and(inArray(s.memberships.userId, memberIds), ne(s.memberships.organizationId, orgId)))
      : [];
    const elsewhereIds = new Set(elsewhere.map((m) => m.userId));
    const demoOnlyUsers = memberIds.filter((id) => !elsewhereIds.has(id));

    const deleted: Record<string, number> = {};
    const count = async (run: Promise<unknown[]>): Promise<number> => (await run).length;

    deleted.reviewDecisions = await count(
      db.delete(s.reviewDecisions).where(eq(s.reviewDecisions.orgId, orgId)).returning({ id: s.reviewDecisions.id }),
    );
    deleted.reviewTasks = await count(
      db.delete(s.reviewTasks).where(eq(s.reviewTasks.orgId, orgId)).returning({ id: s.reviewTasks.id }),
    );
    deleted.annotations = await count(
      db.delete(s.annotations).where(eq(s.annotations.orgId, orgId)).returning({ id: s.annotations.id }),
    );
    deleted.annotationSets = await count(
      db.delete(s.annotationSets).where(eq(s.annotationSets.orgId, orgId)).returning({ id: s.annotationSets.id }),
    );
    deleted.predictions = await count(
      db.delete(s.predictions).where(eq(s.predictions.orgId, orgId)).returning({ id: s.predictions.id }),
    );
    deleted.queueScores = await count(
      db.delete(s.queueScores).where(eq(s.queueScores.orgId, orgId)).returning({ id: s.queueScores.id }),
    );
    deleted.agreementStats = await count(
      db.delete(s.agreementStats).where(eq(s.agreementStats.orgId, orgId)).returning({ id: s.agreementStats.id }),
    );
    deleted.datasetExports = await count(
      db.delete(s.datasetExports).where(eq(s.datasetExports.orgId, orgId)).returning({ id: s.datasetExports.id }),
    );
    deleted.auditLog = await count(
      db.delete(s.auditLog).where(eq(s.auditLog.orgId, orgId)).returning({ id: s.auditLog.id }),
    );
    deleted.invites = await count(
      db.delete(s.invites).where(eq(s.invites.organizationId, orgId)).returning({ id: s.invites.id }),
    );
    deleted.workerTokens = await count(
      db.delete(s.workerTokens).where(eq(s.workerTokens.orgId, orgId)).returning({ id: s.workerTokens.id }),
    );
    deleted.users = demoOnlyUsers.length
      ? await count(db.delete(s.users).where(inArray(s.users.id, demoOnlyUsers)).returning({ id: s.users.id }))
      : 0;
    deleted.memberships = await count(
      db.delete(s.memberships).where(eq(s.memberships.organizationId, orgId)).returning({ id: s.memberships.id }),
    );

    return json({ ok: true, slug, deleted });
  } catch (e) {
    console.error("[demo:reset]", e);
    return unavailable();
  }
}
