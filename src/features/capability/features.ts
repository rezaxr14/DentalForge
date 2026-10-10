/**
 * What each ladder feature has in THIS build (not what the plan eventually
 * wants). The ladder is only honest if these flags are: flip a flag in the same
 * commit that ships the fallback it describes.
 */
import type { FeatureKey } from "./types";

export interface FeatureInfo {
  label: string;
  /** In-browser port exists and is parity-tested. */
  browserReady: boolean;
  /** Precomputed results exist in the repo/DB to replay. */
  replayReady: boolean;
  note: string;
}

export const FEATURES: Record<FeatureKey, FeatureInfo> = {
  "yolo.prelabel": {
    label: "YOLO pre-labeling",
    browserReady: false,
    replayReady: true,
    note: "Replays stored real-YOLO predictions; in-browser ONNX lands with M11.",
  },
  "trace.render_artifacts": {
    label: "Trace tool images",
    browserReady: false,
    // Honesty (ADR-0009 §9): this repo ships NO stored tool renders — the
    // case-study assets live in the VLM-DENTAL repo. The trace viewer shows a
    // labeled placeholder with the recorded args until the renders are ingested
    // (M11). Flip back to true in the commit that actually ships them.
    replayReady: false,
    note: "Stored artifacts replay when present; otherwise a placeholder with the recorded args (renders land with M11).",
  },
  "tool.execute": {
    label: "Tool Lab",
    browserReady: true,
    replayReady: true,
    note: "7 of 8 tools run bit-exact in the browser (locate_tooth needs the worker or replay).",
  },
  "agent.run": {
    label: "Live agent run",
    browserReady: false,
    replayReady: false,
    note: "Needs a worker; the replay view arrives with the Live Agent page (M12).",
  },
  "eval.run": {
    label: "Eval run (new model)",
    browserReady: false,
    replayReady: false,
    note: "Needs a worker; previously imported runs stay browsable.",
  },
  "al.score": {
    label: "Active-learning scores",
    browserReady: false,
    replayReady: true,
    note: "Falls back to stored predictions, then to a heuristic ordering.",
  },
};

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
