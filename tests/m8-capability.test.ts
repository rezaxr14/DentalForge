/**
 * Capability ladder (plan §9.2/9.3), heartbeat-derived worker status, and the
 * hardened store selector (§9.4).
 */
import { describe, expect, it } from "vitest";
import { resolveStrategy } from "@/features/capability/ladder";
import { FEATURES, FEATURE_KEYS } from "@/features/capability/features";
import { contextFor, emptySnapshot, loadWorkerSnapshot, resolveFeature } from "@/features/capability/service";
import { MemoryStore } from "@/shared/db/memory";
import { createStoreSelector, isDegradedStore } from "@/shared/db";
import type { OrgStore } from "@/shared/db/repos";

describe("resolveStrategy — the fixed ladder", () => {
  it("uses a live worker that declares the feature, and never offers to queue what just runs", () => {
    const r = resolveStrategy("yolo.prelabel", { lastHeartbeatMsAgo: 5_000, declaredCapabilities: ["yolo.prelabel"], workerMode: "live" });
    expect(r.strategy).toBe("worker");
    expect(r.queueable).toBe(false);
  });

  it("a degraded worker (30–120 s) still counts; a stale one (>120 s) does not", () => {
    expect(resolveStrategy("agent.run", { lastHeartbeatMsAgo: 60_000, declaredCapabilities: ["agent.run"] }).strategy).toBe("worker");
    const stale = resolveStrategy("agent.run", { lastHeartbeatMsAgo: 200_000, declaredCapabilities: ["agent.run"] });
    expect(stale.strategy).toBe("unavailable");
    expect(stale.workerStatus).toBe("offline");
  });

  it("REGRESSION: mock mode is not magically online — with no heartbeat it falls through", () => {
    const r = resolveStrategy("agent.run", { workerMode: "mock" });
    expect(r.workerStatus).toBe("offline");
    expect(r.strategy).toBe("unavailable");
    expect(r.queueable).toBe(true); // the job would wait for the mock worker
  });

  it("an online worker that does not declare the feature is skipped", () => {
    const r = resolveStrategy("tool.execute", { lastHeartbeatMsAgo: 1_000, declaredCapabilities: ["yolo.prelabel"], toolName: "zoom_crop" });
    expect(r.strategy).toBe("browser");
  });

  it("WORKER_MODE=off ignores heartbeats entirely and cannot queue", () => {
    const r = resolveStrategy("agent.run", { workerMode: "off", lastHeartbeatMsAgo: 1_000, declaredCapabilities: ["agent.run"] });
    expect(r.workerStatus).toBe("offline");
    expect(r.strategy).toBe("unavailable");
    expect(r.queueable).toBe(false);
    expect(r.reason).toContain("WORKER_MODE=off");
  });

  it("falls through browser → replay → heuristic → unavailable in that order", () => {
    // tools: pure ports run in the browser, but locate_tooth needs ONNX/worker, then replay
    expect(resolveStrategy("tool.execute", { toolName: "zoom_crop" }).strategy).toBe("browser");
    expect(resolveStrategy("tool.execute", { toolName: "locate_tooth", hasReplay: true }).strategy).toBe("replay");
    expect(resolveStrategy("tool.execute", { toolName: "locate_tooth" }).strategy).toBe("unavailable");
    expect(resolveStrategy("yolo.prelabel", { browserSupported: true }).strategy).toBe("browser");
    expect(resolveStrategy("yolo.prelabel", { hasReplay: true }).strategy).toBe("replay");
    expect(resolveStrategy("al.score", {}).strategy).toBe("heuristic");
    expect(resolveStrategy("al.score", { hasReplay: true }).strategy).toBe("replay"); // replay outranks the heuristic
    expect(resolveStrategy("trace.render_artifacts", { browserSupported: false, hasReplay: true }).strategy).toBe("replay");
  });

  it("queueable requires a database to hold the job", () => {
    expect(resolveStrategy("agent.run", { workerMode: "live", dbAvailable: false }).queueable).toBe(false);
    expect(resolveStrategy("agent.run", { workerMode: "live", dbAvailable: true }).queueable).toBe(true);
  });
});

describe("worker snapshot (derived on read, no stored flag, no cron)", () => {
  async function seeded() {
    const store = new MemoryStore();
    const org = await store.createOrg({ slug: "cap", name: "cap" });
    const repos = store.scoped(org.id);
    return { store, repos };
  }
  const age = (store: MemoryStore, id: string, ms: number) => {
    store.workers.get(id)!.lastHeartbeatAt = new Date(Date.now() - ms);
  };

  it("derives each worker's status from its heartbeat age and reports the best", async () => {
    const { store, repos } = await seeded();
    const fresh = await repos.registerWorker({ name: "fresh", runtime: "local-gpu", capabilities: ["yolo.prelabel"] });
    const mid = await repos.registerWorker({ name: "mid", runtime: "colab", capabilities: ["tool.execute"] });
    const old = await repos.registerWorker({ name: "old", runtime: "kaggle", capabilities: ["agent.run"] });
    age(store, mid.id, 60_000);
    age(store, old.id, 600_000);
    void fresh;
    const snap = await loadWorkerSnapshot(repos, "live", true);
    const by = Object.fromEntries(snap.workers.map((w) => [w.name, w.status]));
    expect(by).toEqual({ fresh: "online", mid: "degraded", old: "offline" });
    expect(snap.status).toBe("online");
  });

  it("explains why there is no data instead of guessing", async () => {
    const { repos } = await seeded();
    expect(emptySnapshot("live", true, "signed-out").status).toBe("offline");
    expect((await loadWorkerSnapshot(repos, "off", true)).reason).toBe("integration-off");
    expect((await loadWorkerSnapshot(null, "live", true)).reason).toBe("signed-out");
    expect((await loadWorkerSnapshot(repos, "live", false)).reason).toBe("db-unavailable");
  });

  it("matches features to the freshest worker that DECLARES them", async () => {
    const { store, repos } = await seeded();
    const gpu = await repos.registerWorker({ name: "gpu", runtime: "local-gpu", capabilities: ["yolo.prelabel", "tool.execute"] });
    const other = await repos.registerWorker({ name: "agentbox", runtime: "cloud", capabilities: ["agent.run"] });
    age(store, gpu.id, 20_000);
    age(store, other.id, 1_000);
    const snap = await loadWorkerSnapshot(repos, "live", true);

    expect(resolveFeature("yolo.prelabel", snap).strategy).toBe("worker");
    expect(resolveFeature("agent.run", snap).strategy).toBe("worker");
    // Nobody declares eval.run → no worker rung, and no fallback exists for it.
    const ev = resolveFeature("eval.run", snap);
    expect(ev.strategy).toBe("unavailable");
    expect(ev.reason).toContain("does not declare");
    // The freshest *declaring* worker is chosen for the heartbeat age.
    expect(contextFor("yolo.prelabel", snap).lastHeartbeatMsAgo).toBeGreaterThanOrEqual(19_000);
    expect(contextFor("agent.run", snap).lastHeartbeatMsAgo).toBeLessThan(10_000);
  });

  it("with no worker at all, every feature still resolves to something honest (never throws)", async () => {
    const { repos } = await seeded();
    const snap = await loadWorkerSnapshot(repos, "live", true);
    const out = Object.fromEntries(FEATURE_KEYS.map((f) => [f, resolveFeature(f, snap).strategy]));
    expect(out).toEqual({
      "yolo.prelabel": "replay",
      // replayReady flipped to false with the trace-viewer placeholder: no
      // stored renders ship in this repo (ADR-0009 deferred list corrected).
      "trace.render_artifacts": "unavailable",
      "tool.execute": "browser",
      "agent.run": "unavailable",
      "eval.run": "unavailable",
      "al.score": "replay",
    });
    // The static flags this relies on are the single source of truth for "what exists in this build".
    expect(FEATURES["agent.run"].replayReady).toBe(false);
    expect(FEATURES["trace.render_artifacts"].replayReady).toBe(false);
    expect(FEATURES["trace.render_artifacts"].browserReady).toBe(false);
  });

  it("REGRESSION: the feature-level browserReady flag never leaks onto locate_tooth", async () => {
    const { repos } = await seeded();
    const snap = await loadWorkerSnapshot(repos, "live", true);
    // 7 of 8 tools are ported, so the feature flag says browserReady…
    expect(FEATURES["tool.execute"].browserReady).toBe(true);
    // …but locate_tooth has no in-browser port and must never resolve to it.
    const ctx = contextFor("tool.execute", snap, { toolName: "locate_tooth", hasReplay: false });
    expect(ctx.browserSupported).toBe(true); // the flag rides along…
    expect(resolveStrategy("tool.execute", ctx).strategy).toBe("unavailable"); // …but cannot win
    expect(resolveFeature("tool.execute", snap, { toolName: "locate_tooth", hasReplay: false }).strategy).toBe("unavailable");
    expect(resolveFeature("tool.execute", snap, { toolName: "zoom_crop" }).strategy).toBe("browser");
  });
});

describe("createStoreSelector — a failed probe must not pin the process forever", () => {
  const fakeDurable = { tag: "durable" } as unknown as OrgStore;

  it("caches a failure only briefly, keeps ONE memory store, then recovers when the DB comes up", async () => {
    let now = 0;
    let probes = 0;
    let dbUp = false;
    const sel = createStoreSelector({
      probe: async () => {
        probes += 1;
        if (!dbUp) throw new Error("ECONNREFUSED");
      },
      now: () => now,
      negativeTtlMs: 15_000,
      makeDurable: () => fakeDurable,
    });

    const m1 = await sel.get();
    expect(isDegradedStore(m1)).toBe(true);
    now = 5_000;
    expect(await sel.get()).toBe(m1); // within TTL: no re-probe
    expect(probes).toBe(1);

    now = 16_000; // TTL elapsed, DB still down
    const m2 = await sel.get();
    expect(probes).toBe(2);
    expect(m2).toBe(m1); // same in-memory store, so demo data is not lost between probes

    dbUp = true;
    now = 40_000;
    expect(await sel.get()).toBe(fakeDurable); // recovered
    expect(await sel.get()).toBe(fakeDurable);
    expect(probes).toBe(3); // success is cached permanently
  });

  it("concurrent callers share a single in-flight probe", async () => {
    let probes = 0;
    const sel = createStoreSelector({
      probe: async () => {
        probes += 1;
        await new Promise((r) => setTimeout(r, 5));
      },
      makeDurable: () => fakeDurable,
    });
    const all = await Promise.all([sel.get(), sel.get(), sel.get(), sel.get()]);
    expect(probes).toBe(1);
    expect(new Set(all).size).toBe(1);
    sel.reset();
    await sel.get();
    expect(probes).toBe(2);
  });
});
