/**
 * M8 worker/job repository contract (plan §7, §10.1).
 *
 * ONE suite, TWO backends: the in-memory store and the Drizzle/Postgres
 * store must behave identically — leases, ownership gates, idempotency,
 * lazy reaping, cancellation and tenant isolation. The Postgres half also
 * proves the claim is race-free under parallel workers (FOR UPDATE SKIP
 * LOCKED). Like m6-repos, the DB half skips locally without Postgres but
 * FAILS in CI so coverage cannot silently disappear.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore, ScopedRepos } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";

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
    `[m8-jobs-repo] CI requires Postgres but the probe of ${getEnv().DATABASE_URL} failed. ` +
      "The SQL job-queue suite must run on every CI push.",
  );
}

const suffix = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Backend {
  name: string;
  skip: boolean;
  make: () => OrgStore;
}

const backends: Backend[] = [
  { name: "memory", skip: false, make: () => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: () => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("worker/job repository contract — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("jobs", () => {
    let store: OrgStore;
    let orgA: OrgRecord;
    let orgB: OrgRecord;
    let a: ScopedRepos;
    let b: ScopedRepos;

    beforeAll(async () => {
      store = make();
      orgA = await store.createOrg({ slug: `m8-a-${suffix}-${Math.random().toString(36).slice(2, 6)}`, name: "A" });
      orgB = await store.createOrg({ slug: `m8-b-${suffix}-${Math.random().toString(36).slice(2, 6)}`, name: "B" });
      a = store.scoped(orgA.id);
      b = store.scoped(orgB.id);
    });

    afterAll(async () => {
      if (dbUp && store instanceof DrizzleOrgStore) {
        await getPgDb()
          .delete(organizations)
          .where(inArray(organizations.id, [orgA.id, orgB.id]));
      }
    });

    it("register is an upsert by name: a restarted worker keeps its id", async () => {
      const w1 = await a.registerWorker({ name: "gpu-box", runtime: "local-gpu", capabilities: ["yolo.prelabel"] });
      const w2 = await a.registerWorker({ name: "gpu-box", runtime: "colab", capabilities: ["tool.execute"] });
      expect(w2.id).toBe(w1.id);
      expect(w2.runtime).toBe("colab");
      expect(w2.capabilities).toEqual(["tool.execute"]);
      expect((await a.listWorkers()).filter((w) => w.name === "gpu-box")).toHaveLength(1);
      // Same name in another org is a different worker.
      const other = await b.registerWorker({ name: "gpu-box", runtime: "local-gpu" });
      expect(other.id).not.toBe(w1.id);
    });

    it("heartbeat stamps liveness; unknown or foreign workers get null", async () => {
      const w = await a.registerWorker({ name: "hb", runtime: "kaggle" });
      const before = w.lastHeartbeatAt!.getTime();
      await sleep(5);
      const hb = await a.heartbeatWorker(w.id);
      expect(hb!.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(await b.heartbeatWorker(w.id)).toBeNull();
      expect(await a.heartbeatWorker("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("createJob is idempotent per org on the idempotency key", async () => {
      const j1 = await a.createJob({ type: "system.ping", payload: { n: 1 }, idempotencyKey: `k-${suffix}` });
      const j2 = await a.createJob({ type: "system.ping", payload: { n: 2 }, idempotencyKey: `k-${suffix}` });
      expect(j2.id).toBe(j1.id);
      expect(j2.payload).toEqual({ n: 1 });
      const jb = await b.createJob({ type: "system.ping", payload: {}, idempotencyKey: `k-${suffix}` });
      expect(jb.id).not.toBe(j1.id);
    });

    it("claims by priority then age, filtered by accepted types, and leases the job", async () => {
      const t = `prio-${suffix}`;
      const low = await a.createJob({ type: t, payload: { n: "low" }, priority: 0 });
      await sleep(3);
      const high = await a.createJob({ type: t, payload: { n: "high" }, priority: 5 });
      await sleep(3);
      const low2 = await a.createJob({ type: t, payload: { n: "low2" }, priority: 0 });
      await a.createJob({ type: `other-${suffix}`, payload: {} });

      expect(await a.claimJobs("w1", [`nope-${suffix}`], 3, 60)).toEqual([]);
      const got = await a.claimJobs("w1", [t], 2, 60);
      expect(got.map((j) => j.id)).toEqual([high.id, low.id]);
      for (const j of got) {
        expect(j.status).toBe("claimed");
        expect(j.claimedBy).toBe("w1");
        expect(j.attempts).toBe(1);
        expect(j.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      }
      const rest = await a.claimJobs("w2", [t], 5, 60);
      expect(rest.map((j) => j.id)).toEqual([low2.id]);
      expect(await a.claimJobs("w3", [t], 5, 60)).toEqual([]);
    });

    it("parallel workers never receive the same job", async () => {
      const t = `race-${suffix}`;
      for (let i = 0; i < 24; i++) await a.createJob({ type: t, payload: { i } });
      const batches = await Promise.all(
        Array.from({ length: 8 }, (_, i) => a.claimJobs(`racer-${i}`, [t], 4, 60)),
      );
      const ids = batches.flat().map((j) => j.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
      expect(ids.length).toBe(24); // and nothing starved
    });

    it("lazily reaps expired leases: requeue while attempts remain, expire when exhausted", async () => {
      const t = `reap-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      for (let attempt = 1; attempt <= 3; attempt++) {
        const [claimed] = await a.claimJobs("flaky", [t], 1, 0); // lease already expired
        expect(claimed!.id).toBe(job.id);
        expect(claimed!.attempts).toBe(attempt);
        await sleep(5);
        const reaped = await a.reapJobs();
        if (attempt < 3) {
          expect(reaped.requeued).toBeGreaterThanOrEqual(1);
          expect((await a.getJob(job.id))!.status).toBe("queued");
          expect((await a.getJob(job.id))!.claimedBy).toBeNull();
        } else {
          expect(reaped.expired).toBeGreaterThanOrEqual(1);
          const final = (await a.getJob(job.id))!;
          expect(final.status).toBe("expired");
          expect((final.error as { code: string }).code).toBe("lease_expired");
        }
      }
      expect(await a.claimJobs("flaky", [t], 1, 60)).toEqual([]);
    });

    it("renewLeases keeps a live worker's jobs alive, and only its own non-terminal jobs", async () => {
      const t = `renew-${suffix}`;
      const mine = await a.createJob({ type: t, payload: {} });
      const theirs = await a.createJob({ type: t, payload: {} });
      const finished = await a.createJob({ type: t, payload: {} });
      const [m] = await a.claimJobs("alive", [t], 1, 0); // lease already lapsed
      const [th] = await a.claimJobs("other", [t], 1, 0);
      const [f] = await a.claimJobs("alive", [t], 1, 60);
      expect([m!.id, th!.id, f!.id].sort()).toEqual([mine.id, theirs.id, finished.id].sort());
      await a.completeJob(f!.id, "alive", {}, []);
      await sleep(5);

      expect(await a.renewLeases("alive", 60)).toBe(1); // only the lapsed-but-held job
      await a.reapJobs();
      expect((await a.getJob(m!.id))!.status).toBe("claimed"); // survived the reap
      expect((await a.getJob(m!.id))!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect((await a.getJob(th!.id))!.status).toBe("queued"); // the other worker's lapsed job was reaped
      expect((await a.getJob(f!.id))!.status).toBe("succeeded"); // terminal untouched
      expect(await b.renewLeases("alive", 60)).toBe(0); // other tenants never match
    });

    it("a live lease is not reaped", async () => {
      const t = `live-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      await a.claimJobs("steady", [t], 1, 120);
      await a.reapJobs();
      expect((await a.getJob(job.id))!.status).toBe("claimed");
    });

    it("queued jobs expire after the queue TTL", async () => {
      const t = `ttl-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      await sleep(5);
      await a.reapJobs({ queueTtlMs: 1 });
      const after = (await a.getJob(job.id))!;
      expect(after.status).toBe("expired");
      expect((after.error as { code: string }).code).toBe("queue_timeout");
    });

    it("events: owner-only, idempotent on seq, moves claimed → running, extends the lease", async () => {
      const t = `ev-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      await a.claimJobs("owner", [t], 1, 5);

      expect(await a.appendJobEvents(job.id, "intruder", [{ seq: 1, type: "log", data: {} }], 60)).toEqual({
        ok: false,
        code: "not_owner",
      });

      const first = await a.appendJobEvents(
        job.id,
        "owner",
        [
          { seq: 1, type: "progress", data: { pct: 10 } },
          { seq: 2, type: "turn", data: { turn: 1 } },
        ],
        90,
      );
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.value.accepted).toBe(2);
        expect(first.value.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      }
      expect((await a.getJob(job.id))!.status).toBe("running");

      const resend = await a.appendJobEvents(
        job.id,
        "owner",
        [
          { seq: 2, type: "turn", data: { turn: 1 } },
          { seq: 3, type: "partial", data: { x: 1 } },
        ],
        90,
      );
      expect(resend.ok && resend.value.accepted).toBe(1); // only seq 3 is new

      const all = await a.listJobEvents(job.id);
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect((await a.listJobEvents(job.id, 2)).map((e) => e.seq)).toEqual([3]);
      expect(await a.appendJobEvents("00000000-0000-4000-8000-000000000000", "owner", [{ seq: 1, type: "log", data: 0 }], 60)).toEqual({
        ok: false,
        code: "not_found",
      });
    });

    it("a reaped lease means the old worker can no longer write (not_owner)", async () => {
      const t = `fence-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      await a.claimJobs("zombie", [t], 1, 0);
      await sleep(5);
      await a.reapJobs();
      const res = await a.appendJobEvents(job.id, "zombie", [{ seq: 1, type: "log", data: 0 }], 60);
      expect(res).toEqual({ ok: false, code: "not_owner" });
      const [again] = await a.claimJobs("fresh", [t], 1, 60);
      expect(again!.claimedBy).toBe("fresh");
      expect((await a.completeJob(job.id, "zombie", {}, [])).ok).toBe(false);
    });

    it("complete: owner only, stores result + artifacts, idempotent replay, then terminal", async () => {
      const t = `done-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });
      await a.claimJobs("w", [t], 1, 60);

      expect(await a.completeJob(job.id, "other", { ok: 1 }, [])).toEqual({ ok: false, code: "not_owner" });
      const art = await a.createArtifact({
        kind: "tool_image",
        storageKey: `k/${suffix}`,
        mime: "image/png",
        width: 8,
        height: 8,
        bytes: 10,
        sha256: "a".repeat(64),
        provenance: "worker_exact",
      });
      const done = await a.completeJob(job.id, "w", { answer: 42 }, [art.id]);
      expect(done.ok).toBe(true);
      if (done.ok) {
        expect(done.value.status).toBe("succeeded");
        expect(done.value.result).toEqual({ answer: 42 });
        expect(done.value.artifactIds).toEqual([art.id]);
        expect(done.value.leaseExpiresAt).toBeNull();
      }
      expect((await a.completeJob(job.id, "w", { answer: 42 }, [art.id])).ok).toBe(true); // replay
      expect(await a.failJob(job.id, "w", { code: "x", message: "late" })).toEqual({ ok: false, code: "terminal" });
      expect(await a.appendJobEvents(job.id, "w", [{ seq: 9, type: "log", data: 0 }], 60)).toEqual({
        ok: false,
        code: "terminal",
      });
    });

    it("fail: retryable requeues with attempts left, otherwise fails; replay is idempotent", async () => {
      const t = `fail-${suffix}`;
      const job = await a.createJob({ type: t, payload: {} });

      await a.claimJobs("w", [t], 1, 60);
      const retry = await a.failJob(job.id, "w", { code: "oom", message: "cuda oom", retryable: true });
      expect(retry.ok && retry.value.job.status).toBe("queued");
      expect(retry.ok && retry.value.attemptsRemaining).toBe(2);
      expect(retry.ok && retry.value.job.claimedBy).toBeNull();

      await a.claimJobs("w", [t], 1, 60);
      const hard = await a.failJob(job.id, "w", { code: "bad_input", message: "nope" });
      expect(hard.ok && hard.value.job.status).toBe("failed");
      expect(hard.ok && hard.value.attemptsRemaining).toBe(0);
      expect((await a.failJob(job.id, "w", { code: "bad_input", message: "nope" })).ok).toBe(true); // replay

      // Retryable on the LAST attempt cannot requeue.
      const last = await a.createJob({ type: `${t}-last`, payload: {} });
      for (let i = 0; i < 3; i++) {
        const [c] = await a.claimJobs("w", [`${t}-last`], 1, 60);
        expect(c!.id).toBe(last.id);
        const r = await a.failJob(last.id, "w", { code: "oom", message: "again", retryable: true });
        if (i < 2) expect(r.ok && r.value.job.status).toBe("queued");
        else expect(r.ok && r.value.job.status).toBe("failed");
      }
    });

    it("cancel: queued and leased jobs stop; the holder learns via cancelledJobIdsFor; terminal jobs are untouched", async () => {
      const t = `cancel-${suffix}`;
      const queued = await a.createJob({ type: t, payload: {} });
      expect((await a.cancelJob(queued.id))!.status).toBe("cancelled");
      expect(await a.claimJobs("w", [t], 1, 60)).toEqual([]);

      const leased = await a.createJob({ type: `${t}-2`, payload: {} });
      await a.claimJobs("holder", [`${t}-2`], 1, 60);
      expect((await a.cancelJob(leased.id))!.status).toBe("cancelled");
      expect(await a.cancelledJobIdsFor("holder")).toContain(leased.id);
      expect(await a.cancelledJobIdsFor("someone-else")).not.toContain(leased.id);
      expect(await a.appendJobEvents(leased.id, "holder", [{ seq: 1, type: "log", data: 0 }], 60)).toEqual({
        ok: false,
        code: "cancelled",
      });
      expect(await a.completeJob(leased.id, "holder", {}, [])).toEqual({ ok: false, code: "cancelled" });

      const finished = await a.createJob({ type: `${t}-3`, payload: {} });
      await a.claimJobs("w", [`${t}-3`], 1, 60);
      await a.completeJob(finished.id, "w", { r: 1 }, []);
      expect((await a.cancelJob(finished.id))!.status).toBe("succeeded");
      expect(await a.cancelJob("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("listJobs filters by status/type and orders newest first", async () => {
      const t = `list-${suffix}`;
      const j1 = await a.createJob({ type: t, payload: {} });
      await sleep(3);
      const j2 = await a.createJob({ type: t, payload: {} });
      const all = await a.listJobs({ type: t });
      expect(all.map((j) => j.id)).toEqual([j2.id, j1.id]);
      expect(await a.listJobs({ type: t, status: "running" })).toEqual([]);
      expect(await a.listJobs({ type: t, limit: 1 })).toHaveLength(1);
    });

    it("tenant isolation: org B cannot see, claim, cancel, write, or reference org A's job data", async () => {
      const t = `iso-${suffix}`;
      const job = await a.createJob({ type: t, payload: { secret: true } });
      await a.claimJobs("wa", [t], 1, 60);
      const art = await a.createArtifact({
        kind: "report",
        storageKey: `iso/${suffix}`,
        mime: null,
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        provenance: "worker_exact",
      });

      expect(await b.getJob(job.id)).toBeNull();
      expect(await b.listJobs({ type: t })).toEqual([]);
      expect(await b.cancelJob(job.id)).toBeNull();
      expect(await b.claimJobs("wb", [t], 5, 60)).toEqual([]);
      expect(await b.appendJobEvents(job.id, "wa", [{ seq: 1, type: "log", data: 0 }], 60)).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(await b.completeJob(job.id, "wa", {}, [])).toEqual({ ok: false, code: "not_found" });
      expect(await b.listJobEvents(job.id)).toEqual([]);
      expect(await b.getArtifacts([art.id])).toEqual([]);
      expect((await a.getArtifacts([art.id, art.id])).map((x) => x.id)).toEqual([art.id]);
      expect((await a.getJob(job.id))!.status).toBe("claimed"); // untouched
    });

    it("worker tokens: resolve to their org, scope is kept, revocation is final, usage is stamped", async () => {
      const hash = `hash-${suffix}-${Math.random().toString(36).slice(2)}`;
      const tok = await a.createWorkerToken({ name: "ci", tokenHash: hash, scopes: "jobs:write" });
      expect(tok.scopes).toBe("jobs:write");

      const found = await store.findOrgByWorkerTokenHash(hash);
      expect(found!.org.id).toBe(orgA.id);
      expect(found!.token.id).toBe(tok.id);
      expect(await b.getWorkerTokenByHash(hash)).toBeNull();
      expect((await a.listWorkerTokens()).map((t) => t.id)).toContain(tok.id);
      expect((await a.listWorkerTokens())[0]!.tokenHash).toBeTruthy(); // hash only, never the raw token

      expect(await b.revokeWorkerToken(tok.id)).toBe(false); // not yours
      expect(await a.revokeWorkerToken(tok.id)).toBe(true);
      expect(await a.revokeWorkerToken(tok.id)).toBe(false); // already revoked
      expect(await store.findOrgByWorkerTokenHash(hash)).toBeNull();
      expect(await store.findOrgByWorkerTokenHash("no-such-hash")).toBeNull();
    });

    it("getImage is org-pinned", async () => {
      expect(await a.getImage("00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });
});
