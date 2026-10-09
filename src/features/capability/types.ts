/**
 * Capability Ladder & Degradation Types (Plan §9)
 */

export type FeatureKey =
  | "yolo.prelabel"
  | "trace.render_artifacts"
  | "tool.execute"
  | "agent.run"
  | "eval.run"
  | "al.score";

export type StrategyKind = "worker" | "browser" | "replay" | "heuristic" | "unavailable";

export type WorkerStatus = "online" | "degraded" | "offline";

export interface StrategyResolution {
  strategy: StrategyKind;
  reason: string;
  workerStatus: WorkerStatus;
}

export interface CapabilityContext {
  /** Mode override from environment or query string (e.g. chaos switch). */
  workerMode?: "off" | "mock" | "live";
  /** Is browser WebGPU / WASM available? */
  browserSupported?: boolean;
  /** Does a precomputed replay/stored artifact exist? */
  hasReplay?: boolean;
  /** Specific tool name when feature is tool.execute. */
  toolName?: string;
  /** Worker heartbeat info if any active worker exists. */
  lastHeartbeatMsAgo?: number;
  /** Capabilities declared by registered workers. */
  declaredCapabilities?: string[];
}
