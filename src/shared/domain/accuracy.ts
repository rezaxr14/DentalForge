/** Port of reward_accuracy (greedy highest-pair-score-first, F1). */
import type { LooseFinding } from "./metrics";
import type { TrajectoryLike } from "./rewards";
import { normalizeFindings } from "./rewards";

export function rewardAccuracy(traj: TrajectoryLike, groundTruth: unknown): number {
  const preds = normalizeFindings(traj.final_answer);
  const gts = normalizeFindings(groundTruth);
  if (gts.length === 0) return preds.length === 0 ? 1.0 : 0.0;
  if (preds.length === 0) return 0.0;
  const scored: [number, number, number][] = [];
  for (let pi = 0; pi < preds.length; pi++)
    for (let gi = 0; gi < gts.length; gi++)
      scored.push([pairScore(preds[pi] as LooseFinding, gts[gi] as LooseFinding), pi, gi]);
  scored.sort((a, b) => b[0] - a[0]);
  const usedP = new Set<number>(); const usedG = new Set<number>();
  let total = 0;
  for (const [s, pi, gi] of scored) {
    if (usedP.has(pi) || usedG.has(gi)) continue;
    usedP.add(pi); usedG.add(gi); total += s;
  }
  const recall = total / gts.length;
  const precision = total / preds.length;
  if (precision + recall === 0) return 0.0;
  return (2 * precision * recall) / (precision + recall);
}

function pairScore(pred: LooseFinding, gt: LooseFinding): number {
  let s = 0;
  if (pred.quadrant != null && gt.quadrant != null) {
    const pq = Number(pred.quadrant); const gq = Number(gt.quadrant);
    if (Number.isFinite(pq) && Number.isFinite(gq) && Math.trunc(pq) === Math.trunc(gq)) s += 0.25;
  }
  if (pred.tooth_position != null && gt.tooth_position != null) {
    const pp = Number(pred.tooth_position); const gp = Number(gt.tooth_position);
    if (Number.isFinite(pp) && Number.isFinite(gp) && Math.trunc(pp) === Math.trunc(gp)) s += 0.25;
  }
  const pd = String(pred.diagnosis ?? "").trim().toLowerCase();
  const gd = String(gt.diagnosis ?? "").trim().toLowerCase();
  if (pd && gd && pd === gd) s += 0.5;
  return s;
}

export interface RewardWeights {
  accuracy: number; format: number; toolValidity: number; efficiency: number;
}

export const DEFAULT_WEIGHTS: RewardWeights = {
  accuracy: 1.0, format: 0.2, toolValidity: 0.2, efficiency: 0.1,
};

