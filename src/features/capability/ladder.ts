/**
 * Capability Ladder (plan §9.2)
 *
 * Resolves how a feature will execute. Fixed order:
 *   worker (exact) → browser (approximate) → replay (precomputed) → unavailable
 * (`heuristic` is the feature-specific rung for `al.score`.)
 *
 * Worker liveness is derived ONLY from heartbeat age + declared capabilities.
 * `WORKER_MODE=mock` is not special-cased: the mock worker is a real process
 * speaking the real contract, so if it is not running, nothing is online and
 * the ladder must fall through — otherwise enqueued jobs would hang forever.
 * `WORKER_MODE=off` disables the integration outright (heartbeats ignored).
 */
import type { CapabilityContext, FeatureKey, StrategyResolution, WorkerStatus } from "./types";

export function getWorkerStatus(ctx: CapabilityContext): WorkerStatus {
  if (ctx.workerMode === "off") return "offline";
  if (ctx.lastHeartbeatMsAgo === undefined) return "offline";
  if (ctx.lastHeartbeatMsAgo <= 30_000) return "online";
  if (ctx.lastHeartbeatMsAgo <= 120_000) return "degraded";
  return "offline";
}

export function resolveStrategy(feature: FeatureKey, ctx: CapabilityContext = {}): StrategyResolution {
  const workerStatus = getWorkerStatus(ctx);
  const queueableBase = ctx.workerMode !== "off" && ctx.dbAvailable !== false;
  const done = (strategy: StrategyResolution["strategy"], reason: string): StrategyResolution => ({
    strategy,
    reason,
    workerStatus,
    queueable: strategy !== "worker" && queueableBase,
  });

  // 1. Worker (exact). A worker that has not declared the feature does not count.
  const declares = !ctx.declaredCapabilities || ctx.declaredCapabilities.includes(feature);
  if (workerStatus !== "offline" && declares) {
    return done("worker", `Executed by a ${workerStatus} worker (authoritative, exact result).`);
  }

  // 2. Browser (approximate / ported). Never authoritative — callers stamp provenance.
  if (feature === "tool.execute") {
    // `browserSupported` is the FEATURE-level flag (7 of the 8 tools are
    // ported). When a specific tool is named, decide from the tool itself:
    // locate_tooth runs a detector and has no in-browser port (plan §9.2, M4),
    // so it must fall through to replay/unavailable even though the feature
    // flag says "browser ready".
    const ported = ctx.toolName !== undefined ? ctx.toolName !== "locate_tooth" : ctx.browserSupported;
    if (ported) {
      return done("browser", "Computed in-browser via the Canvas2D / Web Worker port (browser approximate).");
    }
  }
  if (feature === "trace.render_artifacts" && ctx.browserSupported !== false) {
    return done("browser", "Re-rendered in-browser from the native image and recorded tool arguments.");
  }
  if (feature === "yolo.prelabel" && ctx.browserSupported) {
    return done("browser", "Ran in-browser via onnxruntime-web in a Web Worker (browser approximate).");
  }

  // 3. Replay (precomputed).
  if (ctx.hasReplay) {
    return done("replay", `Worker ${workerStatus}; showing precomputed results from stored artifacts.`);
  }

  // 4. Feature-specific heuristic.
  if (feature === "al.score") {
    return done("heuristic", `Worker ${workerStatus}; queue ordered by a heuristic (fewest approved boxes).`);
  }

  // 5. Unavailable — with a clear reason.
  const why =
    ctx.workerMode === "off"
      ? "Worker integration is disabled (WORKER_MODE=off)"
      : ctx.declaredCapabilities && workerStatus !== "offline"
        ? `A worker is ${workerStatus} but does not declare ${feature}`
        : `Worker is ${workerStatus}`;
  return done("unavailable", `${why}, and no browser or replay fallback exists for ${feature}.`);
}
