/**
 * M8 task B — worker-token administration core (plan §5.2, §10).
 *
 * ONE suite, TWO backends (memory + Postgres), same rule as m8-jobs-repo:
 * the DB half skips locally without Postgres but FAILS in CI.
 *
 * Pins: admin-only authorization, org scoping / cross-tenant isolation,
 * hash-only storage (raw token returned once, never listed or audited),
 * audit entries, input validation, the active-token cap, and the two
 * failure directions (audit down on create → nothing handed out; audit down
 * on revoke → still revoked).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inArray, like } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations, users, uuidv7 } from "@/shared/db/schema";
import { can } from "@/shared/domain/auth";
import { hashToken } from "@/shared/lib/invites";
import { WORKER_TOKEN_PREFIX } from "@/shared/jobs/tokens";
import {
  MAX_ACTIVE_TOKENS,
  TOKEN_NAME_MAX,
  createTokenForAdmin,
  listTokensForAdmin,
  revokeTokenForAdmin,
} from "@/shared/jobs/token-admin";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();

if (!dbUp && process.env.CI) {
  throw new Error(
    `[m8-token-admin] CI requires Postgres but the probe of ${getEnv().DATABASE_URL} failed. ` +
      "The token-admin suite must run against Postgres on every CI push.",
  );
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe("can(): worker token actions are admin-only", () => {
  it.each(["worker.createToken", "worker.listTokens", "worker.revokeToken"] as const)("%s", (action) => {
    expect(can("admin", action)).toBe(true);
    expect(can("reviewer", action)).toBe(false);
    expect(can("annotator", action)).toBe(false);
  });
});

/** Wrap a store so selected repo calls fail — models an outage of one dependency. */
function withFailing(store: OrgStore, failing: { audit?: boolean; membership?: boolean }): OrgStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "membership" && failing.membership) {
        return () => Promise.reject(new Error("db down"));
      }
      if (prop === "scoped") {
        return (orgId: string) =>
          new Proxy(target.scoped(orgId), {
            get(rt, rp) {
              if (rp === "appendAudit" && failing.audit) return () => Promise.reject(new Error("audit down"));
              const v: unknown = Reflect.get(rt, rp, rt);
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(rt) : v;
            },
          });
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Backend {
  name: string;
  skip: boolean;
  make: () => OrgStore;
}
const backends: Backend[] = [
  { name: "memory", skip: false, make: () => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: () => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("worker token admin — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("core", () => {
    let store: OrgStore;
    let orgA: OrgRecord;
    let orgB: OrgRecord;
    const id = (r: string) => ({ id: uuidv7(), email: `${r}-${suffix}@m8-tokens.test`, name: r });
    const adminA = id("admin-a");
    const annotatorA = id("annot-a");
    const reviewerA = id("review-a");
    const adminB = id("admin-b");
    const stranger = id("stranger");

    beforeAll(async () => {
      store = make();
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().insert(users).values([adminA, annotatorA, reviewerA, adminB, stranger]);
      }
      orgA = await store.createOrg({ slug: `m8t-a-${suffix}`, name: "A" });
      orgB = await store.createOrg({ slug: `m8t-b-${suffix}`, name: "B" });
      await store.addMember({ userId: adminA.id, orgId: orgA.id, role: "admin" });
      await store.addMember({ userId: annotatorA.id, orgId: orgA.id, role: "annotator" });
      await store.addMember({ userId: reviewerA.id, orgId: orgA.id, role: "reviewer" });
      await store.addMember({ userId: adminB.id, orgId: orgB.id, role: "admin" });
    }, 20_000);

    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().delete(organizations).where(inArray(organizations.id, [orgA.id, orgB.id]));
        await getPgDb().delete(users).where(like(users.email, "%@m8-tokens.test"));
      }
    });

    it("create: returns the raw token once; only its hash is stored; it authenticates; audit is clean", async () => {
      const res = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "  rtx4090-box  " });
      if (!res.ok) throw new Error(`expected ok, got ${res.code}`);
      expect(res.token.startsWith(WORKER_TOKEN_PREFIX)).toBe(true);
      expect(res.created).toMatchObject({ name: "rtx4090-box", scope: "jobs:write", lastUsedAt: null, revokedAt: null });

      // resolves to org A with the requested scope, via the hash only
      const found = await store.findOrgByWorkerTokenHash(hashToken(res.token));
      expect(found?.org.id).toBe(orgA.id);
      expect(found?.token.scopes).toBe("jobs:write");
      expect(found?.token.tokenHash).toBe(hashToken(res.token));

      // never listed, never in the audit trail
      const listed = await listTokensForAdmin(store, adminA.id, orgA.id);
      if (!listed.ok) throw new Error("list failed");
      expect(listed.tokens.map((t) => t.id)).toContain(res.created.id);
      const everything = JSON.stringify([listed, res.tokens, await store.scoped(orgA.id).listAudit()]);
      expect(everything).not.toContain(res.token);
      expect(everything).not.toContain(hashToken(res.token));
      expect(everything).not.toContain("tokenHash");

      const audit = (await store.scoped(orgA.id).listAudit()).filter((a) => a.resource === res.created.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "worker.token.create",
        actorId: adminA.id,
        meta: { name: "rtx4090-box", scope: "jobs:write" },
      });
    });

    it("create: honours the requested scope", async () => {
      const res = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "readonly", scope: "jobs:read" });
      if (!res.ok) throw new Error(res.code);
      expect((await store.findOrgByWorkerTokenHash(hashToken(res.token)))?.token.scopes).toBe("jobs:read");
    });

    it("create: rejects bad input and stores nothing", async () => {
      const before = (await store.scoped(orgA.id).listWorkerTokens()).length;
      const bad = [
        { name: "" },
        { name: "   " },
        { name: "x".repeat(TOKEN_NAME_MAX + 1) },
        { name: "ok", scope: "root" as unknown as "admin" },
      ];
      for (const input of bad) {
        const res = await createTokenForAdmin(store, adminA.id, orgA.id, input);
        expect(res).toMatchObject({ ok: false, code: "invalid-input" });
      }
      expect((await store.scoped(orgA.id).listWorkerTokens()).length).toBe(before);
    });

    it("annotators, reviewers and non-members are forbidden for create, list and revoke — and change nothing", async () => {
      const seed = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "target" });
      if (!seed.ok) throw new Error(seed.code);
      const auditBefore = (await store.scoped(orgA.id).listAudit()).length;
      const tokensBefore = (await store.scoped(orgA.id).listWorkerTokens()).length;

      for (const actor of [annotatorA, reviewerA, stranger]) {
        expect(await createTokenForAdmin(store, actor.id, orgA.id, { name: "evil" })).toMatchObject({ ok: false, code: "forbidden" });
        expect(await listTokensForAdmin(store, actor.id, orgA.id)).toMatchObject({ ok: false, code: "forbidden" });
        expect(await revokeTokenForAdmin(store, actor.id, orgA.id, seed.created.id)).toMatchObject({ ok: false, code: "forbidden" });
      }
      expect((await store.scoped(orgA.id).listWorkerTokens()).length).toBe(tokensBefore);
      expect((await store.scoped(orgA.id).listAudit()).length).toBe(auditBefore);
      expect(await store.findOrgByWorkerTokenHash(hashToken(seed.token))).not.toBeNull(); // still valid
    });

    it("cross-tenant: an admin of A can neither manage B nor revoke B's token through A", async () => {
      const bTok = await createTokenForAdmin(store, adminB.id, orgB.id, { name: "b-worker" });
      if (!bTok.ok) throw new Error(bTok.code);

      // acting on org B without being a member of it
      expect(await createTokenForAdmin(store, adminA.id, orgB.id, { name: "x" })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await listTokensForAdmin(store, adminA.id, orgB.id)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await revokeTokenForAdmin(store, adminA.id, orgB.id, bTok.created.id)).toMatchObject({ ok: false, code: "forbidden" });

      // acting on org A with B's token id: indistinguishable from "does not exist"
      expect(await revokeTokenForAdmin(store, adminA.id, orgA.id, bTok.created.id)).toMatchObject({ ok: false, code: "not_found" });

      // A's list never contains B's tokens; B's token still works
      const listA = await listTokensForAdmin(store, adminA.id, orgA.id);
      if (!listA.ok) throw new Error("list");
      expect(listA.tokens.map((t) => t.id)).not.toContain(bTok.created.id);
      expect((await store.findOrgByWorkerTokenHash(hashToken(bTok.token)))?.org.id).toBe(orgB.id);
    });

    it("revoke: the token stops authenticating, is audited, and cannot be revoked twice", async () => {
      const res = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "to-revoke" });
      if (!res.ok) throw new Error(res.code);
      expect(await store.findOrgByWorkerTokenHash(hashToken(res.token))).not.toBeNull();

      const rev = await revokeTokenForAdmin(store, adminA.id, orgA.id, res.created.id);
      if (!rev.ok) throw new Error(rev.code);
      expect(rev.tokens.find((t) => t.id === res.created.id)?.revokedAt).not.toBeNull();
      expect(await store.findOrgByWorkerTokenHash(hashToken(res.token))).toBeNull();

      const audit = (await store.scoped(orgA.id).listAudit()).filter((a) => a.resource === res.created.id).map((a) => a.action);
      expect(audit).toEqual(["worker.token.create", "worker.token.revoke"]);

      expect(await revokeTokenForAdmin(store, adminA.id, orgA.id, res.created.id)).toMatchObject({ ok: false, code: "not_found" });
    });

    it("revoke: unknown or malformed ids are not_found, never a thrown database error", async () => {
      for (const bad of ["no-such-id", "", "'; DROP TABLE worker_tokens;--", uuidv7()]) {
        expect(await revokeTokenForAdmin(store, adminA.id, orgA.id, bad)).toMatchObject({ ok: false, code: "not_found" });
      }
    });

    it("list: active tokens first, newest first, revoked last", async () => {
      const t1 = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "order-1" });
      await new Promise((r) => setTimeout(r, 5));
      const t2 = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "order-2" });
      if (!t1.ok || !t2.ok) throw new Error("create");
      await revokeTokenForAdmin(store, adminA.id, orgA.id, t1.created.id);
      const list = await listTokensForAdmin(store, adminA.id, orgA.id);
      if (!list.ok) throw new Error("list");
      const firstRevoked = list.tokens.findIndex((t) => t.revokedAt);
      expect(list.tokens.slice(firstRevoked).every((t) => t.revokedAt)).toBe(true); // no active token after a revoked one
      const active = list.tokens.filter((t) => !t.revokedAt);
      expect(active.map((t) => t.createdAt)).toEqual([...active.map((t) => t.createdAt)].sort().reverse());
      expect(list.tokens.findIndex((t) => t.id === t2.created.id)).toBeLessThan(list.tokens.findIndex((t) => t.id === t1.created.id));
    });

    it(`limit: at most ${MAX_ACTIVE_TOKENS} active tokens per org; revoking frees a slot`, async () => {
      const org = await store.createOrg({ slug: `m8t-lim-${suffix}`, name: "Limit" });
      try {
        await store.addMember({ userId: adminA.id, orgId: org.id, role: "admin" });
        const ids: string[] = [];
        for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
          const r = await createTokenForAdmin(store, adminA.id, org.id, { name: `t${i}` });
          if (!r.ok) throw new Error(`token ${i}: ${r.code}`);
          ids.push(r.created.id);
        }
        expect(await createTokenForAdmin(store, adminA.id, org.id, { name: "one-too-many" })).toMatchObject({ ok: false, code: "limit_reached" });
        expect((await store.scoped(org.id).listWorkerTokens()).length).toBe(MAX_ACTIVE_TOKENS);

        await revokeTokenForAdmin(store, adminA.id, org.id, ids[0]!);
        expect(await createTokenForAdmin(store, adminA.id, org.id, { name: "fits-now" })).toMatchObject({ ok: true });
      } finally {
        if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, [org.id]));
      }
    });

    it("create: if the audit log is down, the token is retired and never handed out", async () => {
      const broken = withFailing(store, { audit: true });
      const before = (await store.scoped(orgA.id).listWorkerTokens()).filter((t) => !t.revokedAt).map((t) => t.id);
      const res = await createTokenForAdmin(broken, adminA.id, orgA.id, { name: "unauditable" });
      expect(res).toMatchObject({ ok: false, code: "offline" });
      expect(JSON.stringify(res)).not.toContain(WORKER_TOKEN_PREFIX);
      const after = (await store.scoped(orgA.id).listWorkerTokens()).filter((t) => !t.revokedAt).map((t) => t.id);
      expect(after.sort()).toEqual(before.sort()); // the half-created token is revoked again
    });

    it("revoke: if the audit log is down, the revocation still takes effect", async () => {
      const res = await createTokenForAdmin(store, adminA.id, orgA.id, { name: "audit-down-revoke" });
      if (!res.ok) throw new Error(res.code);
      const broken = withFailing(store, { audit: true });
      expect(await revokeTokenForAdmin(broken, adminA.id, orgA.id, res.created.id)).toMatchObject({ ok: true });
      expect(await store.findOrgByWorkerTokenHash(hashToken(res.token))).toBeNull();
    });

    it("an unreachable database is data (offline), not an exception", async () => {
      const down = withFailing(store, { membership: true });
      expect(await listTokensForAdmin(down, adminA.id, orgA.id)).toMatchObject({ ok: false, code: "offline" });
      expect(await createTokenForAdmin(down, adminA.id, orgA.id, { name: "x" })).toMatchObject({ ok: false, code: "offline" });
      expect(await revokeTokenForAdmin(down, adminA.id, orgA.id, uuidv7())).toMatchObject({ ok: false, code: "offline" });
    });
  });
});
