/**
 * M6 platform tests: auth gate, invite tokens, env/capabilities, worker
 * status, storage adapter, and the cross-tenant isolation suite (plan §5.2).
 */
import { describe, expect, it } from "vitest";
import { can } from "@/shared/domain/auth";
import { parseEnv, capabilities, workerStatus } from "@/shared/config/env";
import { mintInvite, verifyInvite, hashToken } from "@/shared/lib/invites";

describe("can() role gate", () => {
  it("all roles read org data", () => {
    for (const role of ["admin", "annotator", "reviewer"] as const) {
      expect(can(role, "trace.read")).toBe(true);
      expect(can(role, "eval.read")).toBe(true);
      expect(can(role, "quality.read")).toBe(true);
    }
  });

  it("only admins manage org/members/workers/imports", () => {
    const adminOnly = [
      "import.run",
      "member.invite",
      "member.changeRole",
      "member.remove",
      "worker.register",
      "worker.revokeToken",
      "org.manage",
    ] as const;
    for (const action of adminOnly) {
      expect(can("admin", action)).toBe(true);
      expect(can("annotator", action)).toBe(false);
      expect(can("reviewer", action)).toBe(false);
    }
  });

  it("nobody approves their own work", () => {
    const self = { authorId: "u1", actorId: "u1" };
    const other = { authorId: "u2", actorId: "u1" };
    expect(can("admin", "annotation.approve", self)).toBe(false);
    expect(can("reviewer", "review.decide", self)).toBe(false);
    expect(can("reviewer", "review.decide", other)).toBe(true);
    expect(can("admin", "annotation.approve", other)).toBe(true);
    expect(can("annotator", "annotation.approve", other)).toBe(false);
  });
});

describe("invite tokens", () => {
  const secret = "test-invite-secret-0123456789abcdef";
  it("round-trips valid claims", () => {
    const { token, tokenHash, claims } = mintInvite(
      { orgId: "org1", role: "annotator", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    );
    expect(token.startsWith("tf_inv_")).toBe(true);
    expect(tokenHash).toBe(hashToken(token));
    const v = verifyInvite(token, secret);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims).toEqual(claims);
  });

  it("rejects wrong secret, expiry, tampering", () => {
    const { token } = mintInvite({ orgId: "o", role: "reviewer", expiresAt: 9_999_999_999 }, secret);
    expect(verifyInvite(token, "wrong-secret").ok).toBe(false);
    const expired = mintInvite({ orgId: "o", role: "reviewer", expiresAt: 1 }, secret).token;
    expect(verifyInvite(expired, secret)).toEqual({ ok: false, reason: "expired" });
    expect(verifyInvite(token.slice(0, -4) + "xxxx", secret).ok).toBe(false);
    expect(verifyInvite("garbage", secret)).toEqual({ ok: false, reason: "bad-prefix" });
  });
});

describe("env + capabilities", () => {
  it("boots with nothing but defaults (all optional off)", () => {
    const env = parseEnv({});
    expect(env.WORKER_MODE).toBe("off");
    expect(env.STORAGE_PROVIDER).toBe("local");
    const caps = capabilities(env);
    expect(caps.redis).toBe(false);
    expect(caps.r2).toBe(false);
    expect(caps.workerMode).toBe("off");
    // The dev-default DATABASE_URL must NOT claim a database exists.
    expect(env.dbConfigured).toBe(false);
    expect(caps.db).toBe(false);
  });

  it("capabilities().db is true only when DATABASE_URL is explicit", () => {
    expect(capabilities(parseEnv({ DATABASE_URL: "postgresql://db:5432/app" })).db).toBe(true);
    expect(capabilities(parseEnv({ DATABASE_URL: "" })).db).toBe(false);
  });

  it("production refuses to boot with missing critical secrets", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL must be set explicitly/);
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET must be set explicitly/);
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/INVITE_SIGNING_SECRET must be set explicitly/);
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_URL must be set explicitly/);
  });

  it("production rejects the publicly known defaults committed to this repo", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://prod:5432/app",
      BETTER_AUTH_URL: "https://traceforge.example",
      BETTER_AUTH_SECRET: "dev-only-secret-min-32-chars-0123456789ab",
      INVITE_SIGNING_SECRET: "change-me-invite-secret",
    };
    expect(() => parseEnv(base)).toThrow(/publicly known value committed to this repo/);
    // Even the .env.example placeholder auth secret is rejected.
    expect(() =>
      parseEnv({ ...base, BETTER_AUTH_SECRET: "change-me-min-32-characters-please", INVITE_SIGNING_SECRET: "unique-invite-secret-0123456789" }),
    ).toThrow(/BETTER_AUTH_SECRET is a publicly known value/);
    // A short (but unique) production secret is also rejected.
    expect(() =>
      parseEnv({ ...base, BETTER_AUTH_SECRET: "short", INVITE_SIGNING_SECRET: "unique-invite-secret-0123456789" }),
    ).toThrow(/at least 32 characters/);
  });

  it("production boots with explicit, strong, unique secrets", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://prod:5432/app",
      BETTER_AUTH_URL: "https://traceforge.example",
      BETTER_AUTH_SECRET: "a-strong-and-unique-production-secret-0123456789",
      INVITE_SIGNING_SECRET: "a-strong-and-unique-invite-secret-0123456789",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.dbConfigured).toBe(true);
    expect(capabilities(env).db).toBe(true);
  });

  it("empty env strings behave like unset values", () => {
    const env = parseEnv({ DATABASE_URL: "", WORKER_MODE: "" });
    expect(env.dbConfigured).toBe(false);
    expect(env.WORKER_MODE).toBe("off");
  });

  it("derives worker status thresholds (30s / 120s)", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(workerStatus(null, now)).toBe("offline");
    expect(workerStatus(new Date("2026-10-07T11:59:40Z"), now)).toBe("online");
    expect(workerStatus(new Date("2026-10-07T11:58:30Z"), now)).toBe("degraded");
    expect(workerStatus(new Date("2026-10-07T11:00:00Z"), now)).toBe("offline");
  });
});

describe("local storage adapter", () => {
  it("round-trips bytes with content-hash keys", async () => {
    const { LocalStorageAdapter, sha256Hex } = await import("@/shared/storage/adapter");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const adapter = new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-storage-")));
    const data = Buffer.from("phantom-bytes");
    const sha = sha256Hex(data);
    const up = await adapter.presignUpload({ name: "x.webp", mime: "image/webp", bytes: data.length, sha256: sha });
    expect(up.key).toContain(sha.slice(0, 2));
    await adapter.write(up.key, data);
    expect((await adapter.read(up.key))?.toString()).toBe("phantom-bytes");
    expect(await adapter.read("artifacts/no/such/key")).toBeNull();
  });
});

describe("cross-tenant isolation (plan §5.2)", () => {
  async function twoOrgs() {
    const { MemoryStore } = await import("@/shared/db/memory");
    const store = new MemoryStore();
    const a = await store.createOrg({ slug: "org-a", name: "A" });
    const b = await store.createOrg({ slug: "org-b", name: "B" });
    await store.addMember({ userId: "alice", orgId: a.id, role: "admin" });
    await store.addMember({ userId: "bob", orgId: b.id, role: "admin" });
    return { store, a, b };
  }

  it("org A cannot list org B datasets, traces, evals, audit", async () => {
    const { store, a, b } = await twoOrgs();
    const rb = store.scoped(b.id);
    await rb.createDataset({ name: "secret", source: "dentex" });
    await rb.createEvalRun({ dataset: "d", split: "s", provider: "p", model: "m", n: 1, summary: {} });
    await rb.appendAudit({ actorId: "bob", action: "x" });
    const ra = store.scoped(a.id);
    expect(await ra.listDatasets()).toHaveLength(0);
    expect(await ra.listTraces()).toHaveLength(0);
    expect(await ra.listEvalRuns()).toHaveLength(0);
    expect(await ra.listAudit()).toHaveLength(0);
  });

  it("org A cannot read or write under org B image/dataset ids", async () => {
    const { store, a, b } = await twoOrgs();
    const rb = store.scoped(b.id);
    const ds = await rb.createDataset({ name: "b-ds", source: "tufts" });
    const img = await rb.createImage({
      datasetId: ds.id, sourceImageId: 7, contentHash: "h", width: 10, height: 10, storageKey: "k", split: null,
    });
    const ra = store.scoped(a.id);
    expect(await ra.listImages(ds.id)).toHaveLength(0);
    expect(await ra.listAnnotations(img.id)).toHaveLength(0);
    await expect(
      ra.createImage({ datasetId: ds.id, sourceImageId: 7, contentHash: "h", width: 1, height: 1, storageKey: "k", split: null }),
    ).rejects.toThrow();
    await expect(
      ra.createAnnotation({
        imageId: img.id, setId: null, bboxX: 0, bboxY: 0, bboxW: 1, bboxH: 1,
        fdiQuadrant: 1, fdiPosition: 1, pathology: "Caries", source: "human", status: "draft", version: 1, authorId: null,
      }),
    ).rejects.toThrow();
  });
});
