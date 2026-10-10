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
  /**
   * True when the UI may offer "queue for later": job integration is on and a
   * database exists to hold the job until a worker connects (plan §9.4 rule 6).
   * Always false while the worker is the chosen strategy (just run it).
   */
  queueable: boolean;
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
  /** Is there a database to persist queued jobs in? Defaults to true when unspecified. */
  dbAvailable?: boolean;
}
