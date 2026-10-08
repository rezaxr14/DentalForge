/**
 * M6 repository layer: cross-tenant isolation (plan §5.2) against the DRIZZLE
 * backend — the same assertions as the memory suite in m6-platform.test.ts,
 * proving `scoped(orgId)` holds in SQL (org_id pinned on every read/write).
 *
 * The DB-backed describe skips without Docker Postgres; the selection tests
 * run everywhere via injected probes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { eq, like } from "drizzle-orm";
import { selectOrgStore } from "@/shared/db";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import { MemoryStore } from "@/shared/db/memory";
import { getEnv } from "@/shared/config/env";
import { getPgDb, getPool } from "@/shared/db/pg";
import { organizations, users, uuidv7 } from "@/shared/db/schema";

describe("org store selection", () => {
  it("falls back to memory when the database probe fails", async () => {
    const store = await selectOrgStore(() => Promise.reject(new Error("db down")));
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it("selects the drizzle store when the probe succeeds", async () => {
    const store = await selectOrgStore(() => Promise.resolve());
    expect(store).toBeInstanceOf(DrizzleOrgStore);
  });
});

const pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
let dbUp = false;
try {
  await pool.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await pool.end();

const suffix = Date.now().toString(36);
const slugA = `m6-repos-a-${suffix}`;
const slugB = `m6-repos-b-${suffix}`;

describe.skipIf(!dbUp)("cross-tenant isolation — drizzle (plan §5.2)", () => {
  let store: DrizzleOrgStore;
  let a: Awaited<ReturnType<DrizzleOrgStore["createOrg"]>>;
  let b: Awaited<ReturnType<DrizzleOrgStore["createOrg"]>>;

  beforeAll(async () => {
    const db = getPgDb();
    store = new DrizzleOrgStore(db);
    await db.insert(users).values([
      { id: uuidv7(), email: `alice-${suffix}@m6-repos.test`, name: "Alice" },
      { id: uuidv7(), email: `bob-${suffix}@m6-repos.test`, name: "Bob" },
    ]);
    a = await store.createOrg({ slug: slugA, name: "A" });
    b = await store.createOrg({ slug: slugB, name: "B" });
    const alice = (
      await db.select().from(users).where(eq(users.email, `alice-${suffix}@m6-repos.test`))
    )[0]!;
    const bob = (
      await db.select().from(users).where(eq(users.email, `bob-${suffix}@m6-repos.test`))
    )[0]!;
    await store.addMember({ userId: alice.id, orgId: a.id, role: "admin" });
    await store.addMember({ userId: bob.id, orgId: b.id, role: "admin" });
  }, 20_000);

  afterAll(async () => {
    const db = getPgDb();
    await db.delete(users).where(like(users.email, "%@m6-repos.test"));
    await db.delete(organizations).where(like(organizations.slug, "m6-repos-%"));
    await getPool().end().catch(() => undefined);
  });

  it("persists orgs, memberships and slug lookups", async () => {
    expect(await store.getOrgBySlug(slugA)).toMatchObject({ id: a.id, name: "A" });
    expect(await store.getOrgBySlug(`nope-${suffix}`)).toBeNull();
    const alice = (
      await getPgDb()
        .select()
        .from(users)
        .where(eq(users.email, `alice-${suffix}@m6-repos.test`))
    )[0]!;
    expect(await store.membership(alice.id, a.id)).toEqual({
      userId: alice.id,
      orgId: a.id,
      role: "admin",
    });
    expect(await store.membership(alice.id, uuidv7())).toBeNull();
  });

  it("org A cannot list org B datasets, traces, evals, audit", async () => {
    const rb = store.scoped(b.id);
    await rb.createDataset({ name: "secret", source: "dentex" });
    await rb.createEvalRun({
      dataset: "d",
      split: "s",
      provider: "p",
      model: "m",
      n: 1,
      summary: {},
    });
    await rb.appendAudit({ actorId: "bob", action: "x" });
    const ra = store.scoped(a.id);
    expect(await ra.listDatasets()).toHaveLength(0);
    expect(await ra.listTraces()).toHaveLength(0);
    expect(await ra.listEvalRuns()).toHaveLength(0);
    expect(await ra.listAudit()).toHaveLength(0);
  });

  it("org A cannot read or write under org B image/dataset ids", async () => {
    const rb = store.scoped(b.id);
    const ds = await rb.createDataset({ name: "b-ds", source: "tufts" });
    const img = await rb.createImage({
      datasetId: ds.id,
      sourceImageId: 7,
      contentHash: "h",
      width: 10,
      height: 10,
      storageKey: "k",
      split: null,
    });
    const ra = store.scoped(a.id);
    expect(await ra.listImages(ds.id)).toHaveLength(0);
    expect(await ra.listAnnotations(img.id)).toHaveLength(0);
    await expect(
      ra.createImage({
        datasetId: ds.id,
        sourceImageId: 7,
        contentHash: "h",
        width: 1,
        height: 1,
        storageKey: "k",
        split: null,
      }),
    ).rejects.toThrow();
    await expect(
      ra.createAnnotation({
        imageId: img.id,
        setId: null,
        bboxX: 0,
        bboxY: 0,
        bboxW: 1,
        bboxH: 1,
        fdiQuadrant: 1,
        fdiPosition: 1,
        pathology: "Caries",
        source: "human",
        status: "draft",
        version: 1,
        authorId: null,
      }),
    ).rejects.toThrow();
  });

  it("scoped reads stay org-pinned for traces with filters", async () => {
    const rb = store.scoped(b.id);
    const ds = await rb.createDataset({ name: "ds", source: "dentex" });
    const img = await rb.createImage({
      datasetId: ds.id,
      sourceImageId: 1,
      contentHash: "x",
      width: 8,
      height: 8,
      storageKey: "k",
      split: "val",
    });
    await rb.createTrace({
      datasetId: ds.id,
      imageId: img.id,
      cohort: "c1",
      mode: "with_tools",
      verified: true,
      sourceFile: null,
      contentHash: "t1",
      nTurns: 2,
      nToolCalls: 3,
      formatOk: true,
      groundTruth: null,
      finalAnswer: null,
    });
    expect(await store.scoped(a.id).listTraces({ datasetId: ds.id })).toHaveLength(0);
    expect(await rb.listTraces({ mode: "with_tools" })).toHaveLength(1);
    expect(await rb.listTraces({ mode: "no_tools" })).toHaveLength(0);
  });
});
