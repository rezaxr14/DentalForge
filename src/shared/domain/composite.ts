import { rewardAccuracy, DEFAULT_WEIGHTS } from "./accuracy";
import type { RewardWeights } from "./accuracy";
import { rewardEfficiency, rewardFormat, rewardToolValidity } from "./rewards";
import type { TrajectoryLike } from "./rewards";

export type { RewardWeights, TrajectoryLike };
export { DEFAULT_WEIGHTS };

/** Port of combine_reward. */
export function combineReward(
  traj: TrajectoryLike,
  groundTruth: unknown,
  weights: RewardWeights = DEFAULT_WEIGHTS,
): {
  total: number;
  components: { accuracy: number; format: number; tool_validity: number; efficiency: number };
} {
  const accuracy = rewardAccuracy(traj, groundTruth);
  const format = rewardFormat(traj);
  const toolValidity = rewardToolValidity(traj);
  const efficiency = rewardEfficiency(traj);
  return {
    total:
      weights.accuracy * accuracy + weights.format * format +
      weights.toolValidity * toolValidity + weights.efficiency * efficiency,
    components: { accuracy, format, tool_validity: toolValidity, efficiency },
  };
}
