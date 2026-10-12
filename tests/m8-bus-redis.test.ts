/**
 * M8 task D — the Redis transport of the wake-up bus, against a REAL redis-server (ADR-0015).
 *
 * `REDIS_TEST_URL` (default redis://127.0.0.1:6379; deliberately NOT `REDIS_URL`, which would reconfigure the app) must point at a server: like Postgres, a missing one FAILS in CI
 * instead of skipping. Two `RedisBus` instances stand in for two serverless instances (a worker-facing one that
 * publishes and a browser-facing one that watches). The restart test spawns its own `redis-server` on a free port
 * and kills it, so it needs the binary (CI installs it).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createClient } from "@redis/client";
import { MemoryStore } from "@/shared/db/memory";
import { jobEventStream } from "@/shared/jobs/sse";
import { DEFAULT_SSE } from "@/shared/jobs/sse";
import { RedisBus } from "@/shared/realtime/redis-bus";
import { createEventBus } from "@/shared/realtime";
import { jobChannel, openWake, safePublish, type EventBus } from "@/shared/realtime/bus";
import { sseReader, stays } from "./helpers/sse-reader";
import { startLegacyRedis } from "./helpers/legacy-redis";

const URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<void>(() => undefined);
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ch = (name: string) => `tf:test:${suffix}:${name}`;

async function eventually(fn: () => boolean | Promise<boolean>, ms = 3000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await delay(20);
  }
}

const probe = new RedisBus(URL);
const redisUp = await probe.ping();
await probe.close();
if (!redisUp && process.env.CI) throw new Error(`[m8-bus-redis] CI requires Redis but ${URL} did not answer PING.`);
const hasBinary = spawnSync("redis-server", ["--version"]).status === 0;
if (!hasBinary && process.env.CI) throw new Error("[m8-bus-redis] CI requires the redis-server binary for the restart test.");

const opened: EventBus[] = [];
const bus = (url = URL) => {
  const b = new RedisBus(url);
  opened.push(b);
  return b;
};
afterEach(async () => {
  await Promise.all(opened.splice(0).map((b) => b.close()));
});
afterAll(async () => {
  await Promise.all(opened.splice(0).map((b) => b.close()));
});

describe.skipIf(!redisUp)("RedisBus against a real server", () => {
  it("a hint published by one instance reaches a subscriber in another", async () => {
    const watcher = bus();
    const worker = bus();
    let hints = 0;
    await watcher.subscribe(ch("x"), () => void (hints += 1));
    await worker.publish(ch("x"));
    await eventually(() => hints === 1, 2000, "the hint");
    expect(watcher.healthy()).toBe(true);
    expect(worker.kind).toBe("redis");
  });

  it("channels are isolated", async () => {
    const a = bus();
    let x = 0;
    let y = 0;
    await a.subscribe(ch("iso-x"), () => void (x += 1));
    await a.subscribe(ch("iso-y"), () => void (y += 1));
    await a.publish(ch("iso-x"));
    await eventually(() => x === 1);
    await delay(100);
    expect([x, y]).toEqual([1, 0]);
  });

  it("many local waiters share ONE server-side subscription, and it is released with the last one", async () => {
    const a = bus();
    const raw = createClient({ url: URL });
    raw.on("error", () => undefined);
    await raw.connect();
    try {
      const counts = [0, 0, 0];
      const unsubs = await Promise.all(counts.map((_, i) => a.subscribe(ch("share"), () => void (counts[i]! += 1))));
      const numsub = async () => Number((await raw.pubSubNumSub(ch("share")))[ch("share")] ?? 0);
      expect(await numsub()).toBe(1); // not 3

      await a.publish(ch("share"));
      await eventually(() => counts.every((c) => c === 1), 2000, "all three waiters");

      await unsubs[0]!();
      await a.publish(ch("share"));
      await eventually(() => counts[1] === 2 && counts[2] === 2);
      expect(counts[0]).toBe(1); // the unsubscribed one stays silent
      expect(await numsub()).toBe(1);

      await unsubs[1]!();
      await unsubs[2]!();
      await eventually(async () => (await numsub()) === 0, 2000, "the server-side subscription to be released");
    } finally {
      raw.destroy();
    }
  });

  it("ping works and an unsubscribed instance still publishes", async () => {
    const a = bus();
    expect(await a.ping()).toBe(true);
    await expect(a.publish(ch("nobody"))).resolves.toBeUndefined();
  });

  it("the whole path: a worker-side publish wakes an SSE stream held by ANOTHER instance", async () => {
    const store = new MemoryStore();
    const org = await store.createOrg({ slug: `redis-sse-${suffix}`, name: "x" });
    const repos = store.scoped(org.id);
    const job = await repos.createJob({ type: "system.ping", payload: {} });
    await repos.claimJobs("w", ["system.ping"], 1, 60);

    const watcherInstance = bus();
    const workerInstance = bus();
    // `never` as the sleep: nothing but a Redis hint can wake this stream
    const stream = jobEventStream(repos, job.id, { ...DEFAULT_SSE, afterSeq: 0, sleep: never, pollMs: 60_000, bus: watcherInstance });
    const rd = sseReader(new Response(stream));
    await rd.until((t) => t.includes("event: status"));
    expect(await stays(rd, 150)).toBe(true);

    await repos.appendJobEvents(job.id, "w", [{ seq: 1, type: "progress", data: { pct: 50 } }], 60);
    await safePublish(workerInstance, jobChannel(job.id)); // what the worker handler does after its write
    await rd.until((t) => t.includes("event: progress"), 2000);
    await rd.cancel();
  });
});

describe("RedisBus with no server", () => {
  // port 1 refuses immediately; this is "Redis is down / misconfigured", the app must not notice
  const dead = "redis://127.0.0.1:1";

  it("everything fails fast, nothing throws unhandled, and the bus reports unhealthy", async () => {
    const b = bus(dead);
    const t0 = Date.now();
    expect(await b.ping()).toBe(false);
    await expect(b.publish(ch("d"))).rejects.toThrow();
    await expect(b.subscribe(ch("d"), () => undefined)).rejects.toThrow();
    expect(b.healthy()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500); // bounded, not a connect-timeout pile-up
  });

  it("safePublish and openWake degrade to polling without an exception", async () => {
    const b = bus(dead);
    await expect(safePublish(b, ch("d"))).resolves.toBeUndefined();
    const wake = await openWake(b, ch("d"));
    expect(wake.live).toBe(false);
    let asked = 0;
    await wake.wait(800, async (ms) => void (asked = ms));
    expect(asked).toBe(800); // fast polling, not the lazy safety interval
  });

  it("createEventBus: no URL, a non-redis URL, and an unreachable URL never throw", async () => {
    expect(await createEventBus(undefined)).toBeUndefined();
    expect(await createEventBus("   ")).toBeUndefined();
    expect(await createEventBus("http://example.com")).toBeUndefined(); // wrong scheme: ignored with a warning
    const b = await createEventBus(dead);
    expect(b?.kind).toBe("redis"); // constructed lazily; it is simply unhealthy
    expect(await b!.ping()).toBe(false);
    await b!.close();
  });
});

describe("RedisBus against a Redis that predates HELLO (5.0-style)", () => {
  it("PREMISE: the client's default protocol (RESP3 → `HELLO 3`) cannot connect to such a server", async () => {
    const legacy = await startLegacyRedis();
    const raw = createClient({ url: legacy.url, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
    raw.on("error", () => undefined);
    try {
      await expect(raw.connect()).rejects.toThrow();
      expect(legacy.commands.some((c) => c[0] === "HELLO")).toBe(true); // it did try, and was refused
    } finally {
      try {
        raw.destroy();
      } catch {
        /* already closed by the failed connect */
      }
      await legacy.close();
    }
  });

  it("the bus (RESP2 pinned) connects, publishes and delivers hints, and never sends HELLO", async () => {
    const legacy = await startLegacyRedis();
    try {
      const watcher = bus(legacy.url);
      const worker = bus(legacy.url);
      let hints = 0;
      const unsub = await watcher.subscribe(ch("legacy"), () => void (hints += 1));
      expect(await worker.ping()).toBe(true);
      await worker.publish(ch("legacy"));
      await eventually(() => hints === 1, 2000, "the hint");
      expect(watcher.healthy()).toBe(true);

      await unsub();
      await worker.publish(ch("legacy"));
      await delay(100);
      expect(hints).toBe(1);
      expect(legacy.commands.some((c) => c[0] === "HELLO")).toBe(false);
    } finally {
      await Promise.all(opened.splice(0).map((b) => b.close()));
      await legacy.close();
    }
  });
});

describe.skipIf(!hasBinary)("RedisBus survives a Redis restart", () => {
  let proc: ChildProcess | null = null;
  afterEach(() => {
    proc?.kill("SIGKILL");
    proc = null;
  });

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
    });
  const confDirs: string[] = [];
  afterAll(() => confDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const startRedis = async (port: number) => {
    // A config FILE rather than argv flags: the Windows port of Redis 5 rejects `--save ""` on the command line.
    const dir = mkdtempSync(join(tmpdir(), "tf-redis-"));
    confDirs.push(dir);
    const conf = join(dir, "redis.conf");
    writeFileSync(conf, `port ${port}\nbind 127.0.0.1\nsave ""\nappendonly no\n`);
    proc = spawn("redis-server", [conf], { stdio: "ignore", cwd: dir });
    const probeBus = new RedisBus(`redis://127.0.0.1:${port}`);
    try {
      await eventually(async () => await probeBus.ping(), 5000, "redis-server to accept connections");
    } finally {
      await probeBus.close();
    }
  };

  it("detects the outage, falls back to fast polling, and resumes WITHOUT re-subscribing", async () => {
    const port = await freePort();
    const url = `redis://127.0.0.1:${port}`;
    await startRedis(port);

    const watcher = bus(url);
    let hints = 0;
    await watcher.subscribe(ch("restart"), () => void (hints += 1));
    const wake = await openWake(watcher, ch("restart"));
    expect(wake.live).toBe(true);

    const publisher = bus(url);
    await publisher.publish(ch("restart"));
    await eventually(() => hints >= 1, 2000, "the first hint");
    const beforeOutage = hints;

    // --- Redis dies hard
    proc!.kill("SIGKILL");
    await eventually(() => !watcher.healthy(), 5000, "the watcher to notice the outage");
    expect(wake.live).toBe(false); // waiters switch back to the short poll interval
    const t0 = Date.now();
    await expect(publisher.publish(ch("restart"))).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500); // fails fast: no queued commands, no hang

    // --- and comes back (empty: no persistence)
    await startRedis(port);
    await eventually(() => watcher.healthy(), 20_000, "the watcher to reconnect on its own");
    expect(wake.live).toBe(true);

    // a brand-new publisher: only the ORIGINAL subscription (never re-issued by us) can deliver this
    const fresh = bus(url);
    await eventually(async () => {
      await fresh.publish(ch("restart")).catch(() => undefined);
      return hints > beforeOutage;
    }, 10_000, "the restored subscription to deliver a hint");
    await wake.close();
  }, 60_000);
});
