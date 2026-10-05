/**
 * M3 quality-signal scanner — pure TS port of scripts/generate_m3_quality.py.
 * Operates on validated trace records; powers the Data-Quality dashboard.
 */
import type { TurnT, VerifiedTraceT } from "../contracts/traces";

export const KNOWN_TOOLS = new Set([
  "zoom_crop", "window_level", "locate_tooth", "fdi_label",
  "denoise", "contralateral_compare", "enhance_contrast", "nudge_crop",
]);

export interface QualityReport {
  nTraces: number;
  directiveLeak: number;
  statuses: Record<string, number>;
  tools: Record<string, number>;
  unknownTools: Record<string, number>;
  healthyFalsePositives: number;
  perturbTiers: Record<string, number>;
}

function bump(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function messageText(m: unknown): string {
  if (typeof m !== "object" || m === null) return "";
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b !== null ? String((b as { text?: unknown }).text ?? "") : String(b),
      )
      .join("\n");
  }
  return "";
}

function hasDirectiveLeak(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => messageText(m).includes("TEACHER DIRECTIVE"));
}

/** Scan one trace's turns/messages; messages may be the sanitized fixture shape. */
export function scanTrace(
  trace: Pick<VerifiedTraceT, "ground_truth" | "final_answer" | "turns"> & { messages: unknown },
): Omit<QualityReport, "nTraces"> {
  const statuses: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const unknownTools: Record<string, number> = {};
  const perturbTiers: Record<string, number> = {};
  for (const t of trace.turns as TurnT[]) {
    bump(statuses, t.status ?? "<none>");
    for (const c of t.tool_calls_this_turn ?? []) {
      bump(tools, c.tool_name);
      if (!KNOWN_TOOLS.has(c.tool_name)) bump(unknownTools, c.tool_name);
      if (c.perturb_tier) bump(perturbTiers, c.perturb_tier);
    }
  }
  const healthyFp = trace.ground_truth.length === 0 && (trace.final_answer?.length ?? 0) > 0 ? 1 : 0;
  return {
    directiveLeak: hasDirectiveLeak(trace.messages) ? 1 : 0,
    statuses, tools, unknownTools, healthyFalsePositives: healthyFp, perturbTiers,
  };
}

/** Merge per-trace scans into a report. */
export function mergeReports(
  scans: Omit<QualityReport, "nTraces">[],
): QualityReport {
  const report: QualityReport = {
    nTraces: scans.length, directiveLeak: 0, statuses: {}, tools: {},
    unknownTools: {}, healthyFalsePositives: 0, perturbTiers: {},
  };
  for (const s of scans) {
    report.directiveLeak += s.directiveLeak;
    report.healthyFalsePositives += s.healthyFalsePositives;
    for (const [k, v] of Object.entries(s.statuses)) bump(report.statuses, k, v);
    for (const [k, v] of Object.entries(s.tools)) bump(report.tools, k, v);
    for (const [k, v] of Object.entries(s.unknownTools)) bump(report.unknownTools, k, v);
    for (const [k, v] of Object.entries(s.perturbTiers)) bump(report.perturbTiers, k, v);
  }
  return report;
}
