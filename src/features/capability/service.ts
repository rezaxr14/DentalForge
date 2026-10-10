/**
 * Worker snapshot → ladder context (plan §9.3).
 *
 * Worker status is DERIVED ON READ from heartbeat age (never a stored flag, no
 * cron). This module has no framework imports so it is unit-testable.
 */
import { workerStatus as statusFromHeartbeat } from "@/shared/config/env";
import type { ScopedRepos } from "@/shared/db/repos";
import { FEATURES } from "./features";
import { resolveStrategy } from "./ladder";
import type { CapabilityContext, FeatureKey, StrategyResolution, WorkerStatus } from "./types";

export type WorkerMode = "off" | "mock" | "live";

export interface WorkerView {
  id: string;
  name: string;
  runtime: string;
  status: WorkerStatus;
  lastHeartbeatAt: string | null;
  capabilities: string[];
}

export interface WorkerSnapshot {
  mode: WorkerMode;
  /** A database-backed org store answered (not the in-memory fallback). */
  dbAvailable: boolean;
  /** Best status across workers (online > degraded > offline); `offline` in mode off. */
  status: WorkerStatus;
  workers: WorkerView[];
  /** Why the snapshot has no worker data, when it does not. */
  reason?: "signed-out" | "db-unavailable" | "integration-off";
}

const RANK: Record<WorkerStatus, number> = { online: 2, degraded: 1, offline: 0 };

export function emptySnapshot(mode: WorkerMode, dbAvailable: boolean, reason?: WorkerSnapshot["reason"]): WorkerSnapshot {
  return { mode, dbAvailable, status: "offline", workers: [], reason };
}

export async function loadWorkerSnapshot(
  repos: ScopedRepos | null,
  mode: WorkerMode,
  dbAvailable: boolean,
  now = new Date(),
): Promise<WorkerSnapshot> {
  if (mode === "off") return emptySnapshot(mode, dbAvailable, "integration-off");
  if (!repos || !dbAvailable) return emptySnapshot(mode, dbAvailable, dbAvailable ? "signed-out" : "db-unavailable");
  const rows = await repos.listWorkers();
  const workers: WorkerView[] = rows.map((w) => ({
    id: w.id,
    name: w.name,
    runtime: w.runtime,
    status: statusFromHeartbeat(w.lastHeartbeatAt, now),
    lastHeartbeatAt: w.lastHeartbeatAt ? w.lastHeartbeatAt.toISOString() : null,
    capabilities: w.capabilities,
  }));
  const status = workers.reduce<WorkerStatus>((best, w) => (RANK[w.status] > RANK[best] ? w.status : best), "offline");
  return { mode, dbAvailable, status, workers };
}

/** Build the ladder context for one feature from a snapshot. */
export function contextFor(feature: FeatureKey, snap: WorkerSnapshot, extra: Partial<CapabilityContext> = {}, now = new Date()): CapabilityContext {
  const info = FEATURES[feature];
  const live = snap.workers.filter((w) => w.status !== "offline" && w.lastHeartbeatAt);
  const declaring = live.filter((w) => w.capabilities.includes(feature));
  // Prefer the freshest worker that actually declares the feature.
  const pool = declaring.length > 0 ? declaring : live;
  const freshest = pool.reduce<WorkerView | null>(
    (best, w) => (!best || new Date(w.lastHeartbeatAt!) > new Date(best.lastHeartbeatAt!) ? w : best),
    null,
  );
  return {
    workerMode: snap.mode,
    dbAvailable: snap.dbAvailable,
    browserSupported: info.browserReady,
    hasReplay: info.replayReady,
    lastHeartbeatMsAgo: freshest ? now.getTime() - new Date(freshest.lastHeartbeatAt!).getTime() : undefined,
    // Declared capabilities of the chosen pool; when NO worker declares the
    // feature this makes the ladder skip the worker rung.
    declaredCapabilities: freshest ? [...new Set(pool.flatMap((w) => w.capabilities))] : undefined,
    ...extra,
  };
}

export function resolveFeature(feature: FeatureKey, snap: WorkerSnapshot, extra: Partial<CapabilityContext> = {}, now = new Date()): StrategyResolution {
  return resolveStrategy(feature, contextFor(feature, snap, extra, now));
}
