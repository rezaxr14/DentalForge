/**
 * M8 task D — the optional realtime wake-up bus (ADR-0015).
 *
 * Contract under test: the bus carries NO data, only hints. Postgres stays the source of truth, so
 *  - with a bus, SSE streams and worker long-polls wake the moment something changes (proved with a sleep that
 *    NEVER resolves, so only a hint can wake them — and a control run showing they hang without one);
 *  - with a missing, failing, hung or lossy bus nothing breaks: writes still succeed (bounded delay), and every
 *    waiter still makes progress through its polling safety net.
 * The Redis transport itself is tested against a real server in m8-bus-redis.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { LocalStorageAdapter } from "@/shared/storage/adapter";
import { sseReader as reader, stays } from "./helpers/sse-reader";
import { mintWorkerToken } from "@/shared/jobs/tokens";
import * as W from "@/shared/jobs/worker-handlers";
import * as U from "@/shared/jobs/user-handlers";
import type { Actor } from "@/shared/jobs/user-handlers";
import {
  MemoryBus,
  PUBLISH_TIMEOUT_MS,
  SAFETY_POLL_MS,
  jobChannel,
  openWake,
  queueChannel,
  safePublish,
  type EventBus,
} from "@/shared/realtime/bus";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-bus] CI requires Postgres; the probe failed.");

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const never = () => new Promise<void>(() => undefined);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delay = realSleep;
const BASE = "http://test.local";

/** A bus that fails everything, as a dead Redis would. */
class DeadBus implements EventBus {
  readonly kind = "redis" as const;
  async publish(): Promise<never> {
    throw new Error("connection refused");
  }
  async subscribe(): Promise<never> {
    throw new Error("connection refused");
  }
  healthy() {
    return false;
  }
  async ping() {
    return false;
  }
  async close() {}
}
/** Accepts publishes and silently drops them (at-most-once delivery gone wrong), while looking healthy. */
class LossyBus extends MemoryBus {
  override async publish(): Promise<void> {}
}
/** A bus whose publish never returns. */
class HungBus extends MemoryBus {
  override publish(): Promise<void> {
    return never();
  }
}

// ---------------------------------------------------------------------------------------------- helpers
describe("safePublish", () => {
  it("is a no-op without a bus", async () => {
    await expect(safePublish(undefined, "c")).resolves.toBeUndefined();
  });

  it("never throws, whatever the bus does", async () => {
    await expect(safePublish(new DeadBus(), "c")).resolves.toBeUndefined();
  });

  it("is bounded: a hung bus delays the caller by at most the timeout", async () => {
    const t0 = Date.now();
    await safePublish(new HungBus(), "c", 60);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(50);
    expect(took).toBeLessThan(400);
  });

  it("a rejection that arrives after we stopped waiting is not an unhandled rejection", async () => {
    let unhandled = false;
    const onUnhandled = () => (unhandled = true);
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = new MemoryBus();
      late.publish = () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late")), 80));
      await safePublish(late, "c", 20);
      await delay(150);
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("MemoryBus", () => {
  it("delivers hints to every subscriber of a channel only", async () => {
    const bus = new MemoryBus();
    const got: string[] = [];
    const u1 = await bus.subscribe("a", () => got.push("a1"));
    await bus.subscribe("a", () => got.push("a2"));
    await bus.subscribe("b", () => got.push("b"));
    await bus.publish("a");
    expect(got.sort()).toEqual(["a1", "a2"]);
    await u1();
    await bus.publish("a");
    expect(got.filter((x) => x === "a1")).toHaveLength(1);
    expect(bus.listenerCount("a")).toBe(1);
  });

  it("refuses work after close and reports unhealthy", async () => {
    const bus = new MemoryBus();
    await bus.close();
    expect(bus.healthy()).toBe(false);
    await expect(bus.publish("a")).rejects.toThrow();
    await expect(bus.subscribe("a", () => undefined)).rejects.toThrow();
  });
});

describe("openWake", () => {
  it("without a bus it is a plain timer at the poll interval", async () => {
    const seen: number[] = [];
    const wake = await openWake(undefined, "c");
    await wake.wait(800, async (ms) => void seen.push(ms));
    expect(seen).toEqual([800]);
    expect(wake.live).toBe(false);
  });

  it("a hint ends a wait that would otherwise last forever", async () => {
    const bus = new MemoryBus();
    const wake = await openWake(bus, "c");
    const waiting = wake.wait(800, never);
    await bus.publish("c");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("a hint that arrives while the caller is busy (before it waits) is not lost", async () => {
    const bus = new MemoryBus();
    const wake = await openWake(bus, "c");
    await bus.publish("c"); // e.g. during the database read
    const t0 = Date.now();
    await wake.wait(800, never); // would hang forever if the hint had been dropped
    expect(Date.now() - t0).toBeLessThan(100);
    // …and it is consumed: the next wait really waits
    let timerAsked = 0;
    await wake.wait(800, async (ms) => void (timerAsked = ms));
    expect(timerAsked).toBe(Math.max(800, SAFETY_POLL_MS));
  });

  it("with a live bus the database is only polled as a safety net; with an unhealthy one it polls fast again", async () => {
    const bus = new MemoryBus();
    const wake = await openWake(bus, "c");
    let asked = 0;
    await wake.wait(800, async (ms) => void (asked = ms));
    expect(asked).toBe(SAFETY_POLL_MS);
    expect(wake.live).toBe(true);
    await wake.wait(800, async (ms) => void (asked = ms), 12_000);
    expect(asked).toBe(12_000);

    const unhealthy = new MemoryBus();
    const w2 = await openWake(unhealthy, "c");
    unhealthy.healthy = () => false; // Redis dropped after we subscribed
    await w2.wait(800, async (ms) => void (asked = ms));
    expect(asked).toBe(800);
    expect(w2.live).toBe(false);
  });

  it("a bus that refuses to subscribe yields a working timer-only wake, never an exception", async () => {
    const wake = await openWake(new DeadBus(), "c");
    expect(wake.live).toBe(false);
    let asked = 0;
    await wake.wait(800, async (ms) => void (asked = ms));
    expect(asked).toBe(800);
  });

  it("a subscription that completes too late is released instead of leaking", async () => {
    const bus = new MemoryBus();
    let released = 0;
    bus.subscribe = () => new Promise((resolve) => setTimeout(() => resolve(() => void (released += 1)), 80));
    const wake = await openWake(bus, "c", 20);
    expect(wake.live).toBe(false);
    await delay(150);
    expect(released).toBe(1);
  });

  it("poke() and close() end a pending wait, close() unsubscribes once, and waits after close return at once", async () => {
    const bus = new MemoryBus();
    const wake = await openWake(bus, "c");
    const p1 = wake.wait(800, never);
    wake.poke();
    await expect(p1).resolves.toBeUndefined();

    const p2 = wake.wait(800, never);
    await wake.close();
    await expect(p2).resolves.toBeUndefined();
    expect(bus.listenerCount("c")).toBe(0);
    await wake.close(); // idempotent
    await expect(wake.wait(800, never)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------- through the real handlers
const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

describe.each(backends)("wake-ups through the handlers — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("integration", () => {
    let store: OrgStore;
    let org: OrgRecord;
    let other: OrgRecord;
    let token: string;
    let admin: Actor;
    let outsider: Actor;
    let storage: LocalStorageAdapter;

    const wdeps = (over: Partial<W.WorkerDeps> = {}): W.WorkerDeps => ({ store, storage, ...over });
    const udeps = (bus?: EventBus, sse: U.UserDeps["sse"] = {}, actor: Actor = admin): U.UserDeps => ({
      store,
      actor,
      workerMode: "live",
      sse,
      ...(bus ? { bus } : {}),
    });
    const wreq = (path: string, body: unknown, workerId?: string) =>
      new Request(`${BASE}/api/worker/v1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-contract-version": "1",
          authorization: `Bearer ${token}`,
          ...(workerId ? { "x-worker-id": workerId } : {}),
        },
        body: JSON.stringify(body),
      });
    const ureq = (path: string, body?: unknown) =>
      new Request(`${BASE}/api/jobs${path}`, { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    async function registerWorker() {
      const res = await W.register(wreq("/register", { name: `w-${Math.random().toString(36).slice(2, 6)}`, runtime: "local-gpu", capabilities: [{ job: "system.ping" }] }), wdeps());
      return ((await res.json()) as { workerId: string }).workerId;
    }
    async function enqueue(bus?: EventBus) {
      const res = await U.createJob(ureq("", { type: "system.ping", payload: {} }), udeps(bus));
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }
    async function claim(workerId: string, bus?: EventBus) {
      const res = await W.claim(wreq("/jobs/claim", { workerId, accepts: ["system.ping"], max: 1, waitMs: 0 }, workerId), wdeps({ ...(bus ? { bus } : {}), sleep: async () => {} }));
      return ((await res.json()) as { jobs: { id: string }[] }).jobs;
    }
    const post = (jobId: string, workerId: string, seq: number, bus?: EventBus) =>
      W.postEvents(wreq(`/jobs/${jobId}/events`, { events: [{ seq, type: "progress", data: { n: seq } }] }, workerId), wdeps(bus ? { bus } : {}), jobId);

    const created: string[] = [];
    beforeAll(async () => {
      store = make();
      storage = new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-m8bus-")), { secret: "test-secret-test-secret-test-secret-0123" });
      other = await store.createOrg({ slug: `m8bus-o-${suffix}-${Math.random().toString(36).slice(2, 6)}`, name: "Other" });
      created.push(other.id);
      outsider = { userId: "u-out", orgId: other.id, role: "admin" };
    });
    // A fresh organization per test: a shared queue would let one test's leftover job be claimed by another.
    beforeEach(async () => {
      org = await store.createOrg({ slug: `m8bus-a-${suffix}-${Math.random().toString(36).slice(2, 8)}`, name: "A" });
      created.push(org.id);
      const m = mintWorkerToken();
      token = m.token;
      await store.scoped(org.id).createWorkerToken({ name: "t", tokenHash: m.tokenHash, scopes: "jobs:write" });
      admin = { userId: "u-admin", orgId: org.id, role: "admin" };
    });
    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) await getPgDb().delete(organizations).where(inArray(organizations.id, created));
    });

    // ------------------------------------------------------------ SSE
    it("an event posted by a worker reaches an open stream at once — while polling is effectively disabled", async () => {
      const bus = new MemoryBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(bus);
      await claim(workerId, bus);

      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status")); // the initial read
      expect(await stays(rd, 120)).toBe(true); // parked: no hint, no sleep that could wake it

      await post(jobId, workerId, 1, bus); // the worker's write publishes a hint
      await rd.until((t) => t.includes("event: progress"), 1500);
      await rd.cancel();
    });

    it("CONTROL: without a bus the same stream stays parked after the same write", async () => {
      const workerId = await registerWorker();
      const jobId = await enqueue();
      await claim(workerId);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(undefined, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      await post(jobId, workerId, 1);
      expect(await stays(rd, 300)).toBe(true); // nothing woke it
      await rd.cancel();
    });

    it("completion wakes the stream and it ends cleanly, releasing its subscription", async () => {
      const bus = new MemoryBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(bus);
      await claim(workerId, bus);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      expect(bus.listenerCount(jobChannel(jobId))).toBe(1);

      const done = await W.complete(wreq(`/jobs/${jobId}/complete`, { result: { echo: "x", workerName: "w", steps: 0 }, artifactIds: [] }, workerId), wdeps({ bus }), jobId);
      expect(done.status).toBe(200);
      await rd.until((t) => t.includes("event: end"), 1500);
      await rd.until(() => rd.done, 1500);
      expect(bus.listenerCount(jobChannel(jobId))).toBe(0);
    });

    it("cancelling a job wakes its stream", async () => {
      const bus = new MemoryBus();
      const jobId = await enqueue(bus);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      const c = await U.cancelJob(ureq(`/${jobId}/cancel`), udeps(bus), jobId);
      expect(c.status).toBe(200);
      await rd.until((t) => t.includes("event: end") && t.includes("cancelled"), 1500);
    });

    it("a claim wakes the stream too (status queued → claimed)", async () => {
      const bus = new MemoryBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(bus);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes('"status":"queued"'));
      await claim(workerId, bus);
      await rd.until((t) => t.includes('"status":"claimed"'), 1500);
      await rd.cancel();
    });

    it("hints for OTHER jobs do not wake a stream, and cancelling the response releases the subscription", async () => {
      const bus = new MemoryBus();
      const jobId = await enqueue(bus);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: never, pollMs: 60_000 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      await bus.publish(jobChannel("00000000-0000-4000-8000-000000000000"));
      await bus.publish(queueChannel(org.id));
      expect(await stays(rd, 150)).toBe(true);
      expect(bus.listenerCount(jobChannel(jobId))).toBe(1);
      await rd.cancel();
      await delay(20);
      expect(bus.listenerCount(jobChannel(jobId))).toBe(0); // released at once, not after a safety interval
    });

    it("tenancy: a foreign job's stream is a 404 and subscribes to nothing", async () => {
      const bus = new MemoryBus();
      const jobId = await enqueue(bus);
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, {}, outsider), jobId);
      expect(res.status).toBe(404);
      expect(bus.listenerCount(jobChannel(jobId))).toBe(0);
    });

    // ------------------------------------------------------------ worker long-poll
    it("a parked worker long-poll is woken by a newly queued job — only the hint can wake it", async () => {
      const bus = new MemoryBus();
      const workerId = await registerWorker();
      const claiming = W.claim(
        wreq("/jobs/claim", { workerId, accepts: ["system.ping"], max: 1, waitMs: 20_000 }, workerId),
        wdeps({ bus, sleep: never }),
      );
      const first = await Promise.race([claiming.then(() => "returned"), delay(150).then(() => "parked")]);
      expect(first).toBe("parked");
      expect(bus.listenerCount(queueChannel(org.id))).toBe(1);

      const jobId = await enqueue(bus);
      const res = await Promise.race([claiming, delay(2000).then(() => null)]);
      expect(res).not.toBeNull();
      expect(((await res!.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(jobId);
      expect(bus.listenerCount(queueChannel(org.id))).toBe(0); // released when the claim returned
    });

    it("CONTROL: without a bus a parked long-poll does not notice the new job until its next poll", async () => {
      const workerId = await registerWorker();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const claiming = W.claim(wreq("/jobs/claim", { workerId, accepts: ["system.ping"], max: 1, waitMs: 20_000 }, workerId), wdeps({ sleep: () => gate }));
      await delay(100);
      const jobId = await enqueue(); // no hint
      expect(await Promise.race([claiming.then(() => "returned"), delay(250).then(() => "parked")])).toBe("parked");
      release(); // the next poll finds it
      const jobs = ((await (await claiming).json()) as { jobs: { id: string }[] }).jobs;
      expect(jobs.map((j) => j.id)).toContain(jobId);
    });

    it("a failed job that goes back to the queue wakes parked claimers", async () => {
      const bus = new MemoryBus();
      const w1 = await registerWorker();
      const w2 = await registerWorker();
      const jobId = await enqueue(bus);
      expect((await claim(w1, bus)).map((j) => j.id)).toContain(jobId);
      const claiming = W.claim(wreq("/jobs/claim", { workerId: w2, accepts: ["system.ping"], max: 1, waitMs: 20_000 }, w2), wdeps({ bus, sleep: never }));
      await delay(100);
      const f = await W.fail(wreq(`/jobs/${jobId}/fail`, { error: { code: "boom", message: "x", retryable: true } }, w1), wdeps({ bus }), jobId);
      expect(f.status).toBe(200);
      const res = await Promise.race([claiming, delay(2000).then(() => null)]);
      expect(res).not.toBeNull();
      expect(((await res!.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(jobId);
    });

    // ------------------------------------------------------------ the bus misbehaves
    it("DEAD bus: writes succeed, streams and long-polls still progress by polling", async () => {
      const bus = new DeadBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(bus); // publish fails silently
      expect((await claim(workerId, bus)).map((j) => j.id)).toContain(jobId);

      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: realSleep, pollMs: 5 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      expect((await post(jobId, workerId, 1, bus)).status).toBe(200); // not failed by the dead bus
      await rd.until((t) => t.includes("event: progress"), 1500); // found by polling
      await rd.cancel();
    });

    it("LOSSY bus (looks healthy, drops every hint): the safety poll still delivers", async () => {
      const bus = new LossyBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(bus);
      await claim(workerId, bus);
      // pollMs is the SHORT interval; with a live bus the stream polls every max(pollMs, safetyPollMs) = 40 ms
      const res = await U.jobEvents(new Request(`${BASE}/api/jobs/${jobId}/events`), udeps(bus, { sleep: realSleep, pollMs: 1, safetyPollMs: 40 }), jobId);
      const rd = reader(res);
      await rd.until((t) => t.includes("event: status"));
      await post(jobId, workerId, 1, bus); // hint is dropped…
      await rd.until((t) => t.includes("event: progress"), 1500); // …but the safety poll finds the event
      await rd.cancel();
    });

    it("HUNG bus: a write is delayed by at most the publish timeout, and still succeeds", async () => {
      const bus = new HungBus();
      const workerId = await registerWorker();
      const jobId = await enqueue(); // no bus for the setup
      await claim(workerId);
      const t0 = Date.now();
      const res = await post(jobId, workerId, 1, bus);
      const took = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(took).toBeGreaterThanOrEqual(PUBLISH_TIMEOUT_MS - 50);
      expect(took).toBeLessThan(PUBLISH_TIMEOUT_MS + 1000);
    });
  });
});
