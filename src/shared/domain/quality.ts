/**
 * M3 quality-signal scanner — pure TS port of scripts/generate_m3_quality.py.
 * Operates on validated trace records; powers the Data-Quality dashboard.
 *
 * Leak definition (R1 / plan section 11.5): a *directive leak* is the
 * ASSISTANT's text matching LEAK_PATTERNS from VLM-DENTAL
 * `scripts/patch_and_regenerate_traces.py::check_for_leaks` (assistant role
 * only, first matching pattern per message). The string `TEACHER DIRECTIVE`
 * inside the stored *user* message is the generation scaffold — reported
 * separately as `teacherScaffold` (expected, not a leak).
 */
import type { TurnT, VerifiedTraceT } from "../contracts/traces";

export const KNOWN_TOOLS = new Set([
  "zoom_crop", "window_level", "locate_tooth", "fdi_label",
  "denoise", "contralateral_compare", "enhance_contrast", "nudge_crop",
]);

/**
 * Port of VLM-DENTAL LEAK_PATTERNS (scripts/patch_and_regenerate_traces.py).
 * Order preserved; semantics: case-insensitive regex search.
 */
export const LEAK_PATTERNS: RegExp[] = [
  /\bteacher('s)? directive\b/i,
  /\bsystem directive\b/i,
  /\btask directive\b/i,
  /\bthe directives?\b/i,
  /\bper directive\b/i,
  /\bper the directive\b/i,
  /\bdirectives?\s+(says?|states?|mentions?|points?|identifies?|specifies?|suggests?|indicates?|listed)\b/i,
  /\bground truth\b/i,
  /\bteacher('s)? hint\b/i,
  /\buser('s)? hint\b/i,
  /\bmentioned in the (hint|directive)\b/i,
  /\bin the hint\b/i,
  /\bgiven to me\b/i,
  /\binstruction told me\b/i,
  /\btold to find\b/i,
];

export interface LeakHit {
  turnIdx: number;
  pattern: string;
}

export interface QualityReport {
  nTraces: number;
  /** Assistant-text leak (real VLM-DENTAL definition). */
  directiveLeak: number;
  /** Generation scaffold present in stored user messages (expected). */
  teacherScaffold: number;
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

function messageRole(m: unknown): string | null {
  if (typeof m !== "object" || m === null) return null;
  const role = (m as { role?: unknown }).role;
  return typeof role === "string" ? role : null;
}

/**
 * Assistant-only leak scan (mirrors `check_for_leaks`): for each assistant
 * message, record the first matching pattern. Returns one hit per message.
 */
export function scanAssistantLeaks(messages: unknown): LeakHit[] {
  if (!Array.isArray(messages)) return [];
  const hits: LeakHit[] = [];
  messages.forEach((m, turnIdx) => {
    if (messageRole(m) !== "assistant") return;
    const text = messageText(m);
    for (const pat of LEAK_PATTERNS) {
      pat.lastIndex = 0;
      const found = pat.exec(text);
      if (found) {
        const first = found[0];
        if (first !== undefined) hits.push({ turnIdx, pattern: first });
        break;
      }
    }
  });
  return hits;
}

/** Assistant `parsed.thought` leak scan (turn-level, same patterns). */
export function scanThoughtLeaks(turns: TurnT[]): { turn: number; pattern: string }[] {
  const hits: { turn: number; pattern: string }[] = [];
  for (const t of turns) {
    const thought = t.parsed && typeof t.parsed === "object" ? t.parsed.thought : undefined;
    if (typeof thought !== "string") continue;
    for (const pat of LEAK_PATTERNS) {
      pat.lastIndex = 0;
      const found = pat.exec(thought);
      if (found) {
        const first = found[0];
        if (first !== undefined) hits.push({ turn: t.turn, pattern: first });
        break;
      }
    }
  }
  return hits;
}

/** Generation scaffold: stored non-assistant message with the marker. */
export function hasTeacherScaffold(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => messageRole(m) !== "assistant" && messageText(m).includes("TEACHER DIRECTIVE"),
  );
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
  const leakHits = scanAssistantLeaks(trace.messages);
  const thoughtHits = scanThoughtLeaks(trace.turns as TurnT[]);
  return {
    directiveLeak: leakHits.length + thoughtHits.length > 0 ? 1 : 0,
    teacherScaffold: hasTeacherScaffold(trace.messages) ? 1 : 0,
    statuses, tools, unknownTools, healthyFalsePositives: healthyFp, perturbTiers,
  };
}

/** Merge per-trace scans into a report. */
export function mergeReports(
  scans: Omit<QualityReport, "nTraces">[],
): QualityReport {
  const report: QualityReport = {
    nTraces: scans.length, directiveLeak: 0, teacherScaffold: 0, statuses: {}, tools: {},
    unknownTools: {}, healthyFalsePositives: 0, perturbTiers: {},
  };
  for (const s of scans) {
    report.directiveLeak += s.directiveLeak;
    report.teacherScaffold += s.teacherScaffold;
    report.healthyFalsePositives += s.healthyFalsePositives;
    for (const [k, v] of Object.entries(s.statuses)) bump(report.statuses, k, v);
    for (const [k, v] of Object.entries(s.tools)) bump(report.tools, k, v);
    for (const [k, v] of Object.entries(s.unknownTools)) bump(report.unknownTools, k, v);
    for (const [k, v] of Object.entries(s.perturbTiers)) bump(report.perturbTiers, k, v);
  }
  return report;
}
