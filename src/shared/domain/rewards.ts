/**
 * M2 port of dental_agent/rewards/{components,composite}.py.
 * Parity enforced by tests/m2-parity.test.ts.
 */
import type { LooseFinding } from "./metrics";

export interface TrajectoryLike {
  format_ok?: unknown;
  final_answer?: unknown;
  turns?: unknown;
  tool_calls?: unknown;
}

interface ToolCall {
  name: unknown;
  args: Record<string, unknown>;
  ok: boolean;
}

function iterToolCalls(traj: TrajectoryLike): ToolCall[] {
  const turns = traj.turns;
  if (!Array.isArray(turns)) return [];
  const out: ToolCall[] = [];
  for (const t of turns) {
    if (typeof t !== "object" || t === null) continue;
    const calls = (t as { tool_calls_this_turn?: unknown }).tool_calls_this_turn;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      out.push({
        name: rec.tool_name,
        args: (rec.tool_args as Record<string, unknown>) ?? {},
        ok: Boolean(rec.tool_ok),
      });
    }
  }
  return out;
}

export function normalizeFindings(x: unknown): LooseFinding[] {
  if (Array.isArray(x)) return x.filter((f): f is LooseFinding => typeof f === "object" && f !== null);
  if (typeof x === "object" && x !== null) return [x as LooseFinding];
  return [];
}

/** Port of reward_format (+ _is_valid_final_answer: any dict incl. {} counts, lists need len > 0). */
export function rewardFormat(traj: TrajectoryLike): number {
  if (traj.format_ok) return 1.0;
  const fa = traj.final_answer;
  if (Array.isArray(fa)) return fa.length > 0 ? 1.0 : 0.0;
  if (typeof fa === "object" && fa !== null) return 1.0;
  return 0.0;
}

/** Port of reward_tool_validity. */
export function rewardToolValidity(traj: TrajectoryLike): number {
  const calls = iterToolCalls(traj);
  if (calls.length === 0) return 1.0;
  return calls.filter((c) => c.ok).length / calls.length;
}


/** Port of reward_efficiency. */
export function rewardEfficiency(traj: TrajectoryLike, maxCalls = 50, callsPerFinding = 6): number {
  const calls = iterToolCalls(traj);
  if (calls.length === 0) return 1.0;
  const exempt = new Set(["locate_tooth", "nudge_crop"]);
  const lowCost = new Set(["fdi_label"]);
  const located = new Set<number>();
  for (const c of calls) {
    if (c.name === "locate_tooth" && c.ok) {
      const n = Number(c.args.tooth);
      if (Number.isFinite(n)) located.add(Math.trunc(n));
    }
  }
  const nFindings = Math.max(1, located.size);
  const budget = Math.min(maxCalls, nFindings * callsPerFinding);
  let billable = 0;
  let prev: string | null = null;
  for (const c of calls) {
    const key = `${String(c.name)}:${JSON.stringify(sortedEntries(c.args))}`;
    if (exempt.has(String(c.name))) { prev = key; continue; }
    let cost = lowCost.has(String(c.name)) ? 0.2 : 1.0;
    if (prev === key) cost *= 5.0;
    billable += cost;
    prev = key;
  }
  if (billable <= budget) return 1.0;
  const overage = billable - budget;
  return Math.max(0, Math.min(1, 1.0 / (1.0 + overage / Math.max(1.0, budget))));
}

function sortedEntries(args: Record<string, unknown>): [string, unknown][] {
  return Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
