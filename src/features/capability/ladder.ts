/**
 * Capability Ladder (Plan §9.2)
 *
 * Resolves how a feature will execute:
 * Fixed order: worker (exact) → browser (approximate) → replay (precomputed) → unavailable.
 */
import type { CapabilityContext, FeatureKey, StrategyResolution, WorkerStatus } from "./types";

export function getWorkerStatus(ctx: CapabilityContext): WorkerStatus {
  if (ctx.workerMode === "off") return "offline";
  if (ctx.workerMode === "mock") return "online";

  if (ctx.lastHeartbeatMsAgo !== undefined) {
    if (ctx.lastHeartbeatMsAgo <= 30_000) return "online";
    if (ctx.lastHeartbeatMsAgo <= 120_000) return "degraded";
    return "offline";
  }

  return "offline";
}

export function resolveStrategy(
  feature: FeatureKey,
  ctx: CapabilityContext = {},
): StrategyResolution {
  const workerStatus = getWorkerStatus(ctx);
  const workerCapable =
    workerStatus !== "offline" &&
    (ctx.workerMode === "mock" ||
      !ctx.declaredCapabilities ||
      ctx.declaredCapabilities.includes(feature));

  // 1. Worker (Exact)
  if (workerCapable) {
    return {
      strategy: "worker",
      reason: `Executed by ${workerStatus} Python/mock worker (authoritative exact result).`,
      workerStatus,
    };
  }

  // 2. Browser (Approximate / Ported)
  if (feature === "tool.execute") {
    const isPureMathOrCanvas = ctx.toolName && ctx.toolName !== "locate_tooth";
    if (isPureMathOrCanvas || ctx.browserSupported) {
      return {
        strategy: "browser",
        reason: "Computed in-browser via Canvas2D / WebWorker pure port (browser approximate).",
        workerStatus,
      };
    }
  }

  if (feature === "trace.render_artifacts" && ctx.browserSupported !== false) {
    return {
      strategy: "browser",
      reason: "Re-rendered in-browser from native image and recorded tool arguments.",
      workerStatus,
    };
  }

  if (feature === "yolo.prelabel" && ctx.browserSupported) {
    return {
      strategy: "browser",
      reason: "Ran in-browser via onnxruntime-web in Web Worker (browser approximate).",
      workerStatus,
    };
  }

  // 3. Replay (Precomputed)
  if (ctx.hasReplay) {
    return {
      strategy: "replay",
      reason: "Worker offline; showing precomputed replay from stored artifacts.",
      workerStatus,
    };
  }

  // 4. Feature-specific heuristic fallback
  if (feature === "al.score") {
    return {
      strategy: "heuristic",
      reason: "Worker offline; queue sorted using heuristic scoring (fewest approved boxes).",
      workerStatus,
    };
  }

  // 5. Unavailable
  return {
    strategy: "unavailable",
    reason: `Worker is ${workerStatus} and no browser or replay fallback is available for ${feature}.`,
    workerStatus,
  };
}
