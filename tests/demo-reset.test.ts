/**
 * `/api/demo/reset` — the Vercel Cron that keeps the public demo usable.
 *
 * It must fail closed without the cron secret, delete only what visitors
 * created in the demo org, keep the seeded rows, and be a no-op on a second run.
 * A test that only asserted the happy path would pass while the route deleted
 * the demo data, so the "seeded rows survive" assertions are the point.
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { eq, inArray } from "drizzle-orm";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import * as s from "@/shared/db/schema";
import { POST } from "@/app/api/demo/reset/route";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[demo-reset] CI requires Postgres; the probe failed.");

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = `demo-reset-${SUFFIX}`;
const SECRET = `test-cron-${SUFFIX}`;
const EMAIL = `visitor-${SUFFIX}@example.test`;

process.env.CRON_SECRET = SECRET;
process.env.DEMO_ORG_SLUG = SLUG;

const db = getPgDb();
const store = new DrizzleOrgStore(db);
let orgId = "";
let imageId = "";
let userId = "";

async function call(init: { authorization?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.authorization) headers.authorization = init.authorization;
  return POST(
    new Request("http://localhost:3000/api/demo/reset", { method: "POST", headers }),
  );
}

describe.skipIf(!dbUp)("POST /api/demo/reset", () => {
  it("sets up a demo org with one seeded image and visitor-created rows", async () => {
    const org = await store.createOrg({ slug: SLUG, name: "Demo" });
    orgId = org.id;
    const repo = store.scoped(orgId);
    // openAnnotationSet creates the dataset + image + set a visitor would open.
    const snap = await repo.openAnnotationSet({
      source: "dentex",
      datasetName: "dentex",
      licenseNote: "CC-BY-NC-SA 4.0",
      sourceImageId: 4242,
      contentHash: `sha256:${SUFFIX}`,
      width: 100,
      height: 100,
      storageKey: "demo-assets/images/dentex-1-full.jpg",
      split: "train",
      assigneeId: "visitor",
    });
    imageId = snap.image.id;

    const [user] = await db
      .insert(s.users)
      .values({ email: EMAIL, name: "Visitor" })
      .returning({ id: s.users.id });
    if (!user) throw new Error("user insert returned no row");
    userId = user.id;
    await db.insert(s.memberships).values({ userId, organizationId: orgId, role: "annotator" });
    await db.insert(s.invites).values({ organizationId: orgId, email: EMAIL, role: "annotator" });
    await db.insert(s.auditLog).values({ orgId, action: "labels.open" });

    expect(snap.set.id).toBeTruthy();
  });

  it("rejects a missing or wrong secret without touching data", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    const sets = await db.select({ id: s.annotationSets.id }).from(s.annotationSets).where(eq(s.annotationSets.orgId, orgId));
    expect(sets).toHaveLength(1);
  });

  it("deletes visitor rows and keeps the seeded image and dataset", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.deleted.annotationSets).toBe(1);
    expect(body.deleted.annotations).toBeGreaterThanOrEqual(0);
    expect(body.deleted.users).toBe(1);
    expect(body.deleted.invites).toBe(1);
    expect(body.deleted.auditLog).toBe(1);

    // Deleting the demo-only user cascades its membership, so the membership
    // counter may be 0; what matters is that no membership remains.
    expect(
      await db.select({ id: s.memberships.id }).from(s.memberships).where(eq(s.memberships.organizationId, orgId)),
    ).toHaveLength(0);

    expect(await db.select({ id: s.images.id }).from(s.images).where(eq(s.images.id, imageId))).toHaveLength(1);
    expect(await db.select({ id: s.datasets.id }).from(s.datasets).where(eq(s.datasets.orgId, orgId))).toHaveLength(1);
    expect(await db.select({ id: s.annotationSets.id }).from(s.annotationSets).where(eq(s.annotationSets.orgId, orgId))).toHaveLength(0);
    expect(await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, userId))).toHaveLength(0);
  });

  it("is a no-op on a second run", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: Record<string, number> };
    for (const [table, n] of Object.entries(body.deleted)) {
      expect(n, `${table} should be 0 on the second run`).toBe(0);
    }
    expect(await db.select({ id: s.images.id }).from(s.images).where(eq(s.images.id, imageId))).toHaveLength(1);
  });

  afterAll(async () => {
    if (orgId) await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    if (userId) await db.delete(s.users).where(inArray(s.users.id, [userId]));
  });
});
