import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewardAccuracy } from "../src/shared/domain/accuracy";
import { rewardEfficiency, rewardFormat, rewardToolValidity } from "../src/shared/domain/rewards";
import { combineReward } from "../src/shared/domain/composite";
import {
  classIdxToFdi, dentexRowToFdi, fdiFromParts, fdiToClassIdx, fdiToParts,
} from "../src/shared/domain/fdi";

const goldens = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "goldens", "m2_goldens.json"), "utf-8"),
) as { rewards: Record<string, { total: number; components: Record<string, number> }> };

const trajWithTools = {
  format_ok: true,
  final_answer: [
    { quadrant: 4, tooth_position: 8, diagnosis: "Impacted Tooth", confidence: 0.95 },
    { quadrant: 4, tooth_position: 7, diagnosis: "Caries", confidence: 0.85 },
  ],
  turns: [
    {
      turn: 0, status: "tool_executed",
      tool_calls_this_turn: [
        { tool_name: "locate_tooth", tool_args: { tooth: 48 }, tool_ok: true },
        { tool_name: "locate_tooth", tool_args: { tooth: 47 }, tool_ok: true },
        { tool_name: "zoom_crop", tool_args: { bbox: [1, 2, 3, 4] }, tool_ok: true },
      ],
    },
    { turn: 1, status: "final_answer", raw_output: "{}", parsed: { thought: "done", final_answer: [] } },
  ],
};
const trajNoTools = {
  format_ok: true,
  final_answer: [{ quadrant: 4, tooth_position: 8, diagnosis: "Impacted" }],
  turns: [{ turn: 1, raw_output: "{}", parsed: { thought: "x", final_answer: [] } }],
  tool_calls: [],
};
const trajEmpty = { format_ok: false, final_answer: [], turns: [], tool_calls: [] };
const rewardGt = [
  { quadrant: 4, tooth_position: 8, diagnosis: "Impacted" },
  { quadrant: 4, tooth_position: 7, diagnosis: "Caries" },
];

describe("M2 parity: rewards", () => {
  it.each(["with_tools", "no_tools", "empty"] as const)("combine_reward %s matches golden", (name) => {
    const traj = name === "with_tools" ? trajWithTools : name === "no_tools" ? trajNoTools : trajEmpty;
    const g = goldens.rewards[name] as { total: number; components: Record<string, number> };
    const { total, components } = combineReward(traj, rewardGt);
    expect(total).toBeCloseTo(g.total, 9);
    expect(components.accuracy).toBeCloseTo(g.components.accuracy as number, 9);
    expect(components.format).toBeCloseTo(g.components.format as number, 9);
    expect(components.tool_validity).toBeCloseTo(g.components.tool_validity as number, 9);
    expect(components.efficiency).toBeCloseTo(g.components.efficiency as number, 9);
  });

  it("component spot checks", () => {
    expect(rewardFormat(trajWithTools)).toBe(1);
    expect(rewardToolValidity(trajWithTools)).toBe(1);
    expect(rewardEfficiency(trajNoTools)).toBe(1);
    expect(rewardAccuracy(trajEmpty, rewardGt)).toBe(0);
    expect(rewardAccuracy({ final_answer: [] }, [])).toBe(1);
  });
});

describe("M2: FDI helpers", () => {
  it("round-trips FDI <-> parts", () => {
    expect(fdiToParts(48)).toEqual({ quadrant: 4, position: 8 });
    expect(fdiFromParts(4, 8)).toBe(48);
    expect(() => fdiToParts(59)).toThrow(RangeError);
  });
  it("DENTEX 0-index conversion is the single +1 site", () => {
    expect(dentexRowToFdi(3, 7)).toEqual({ quadrant: 4, position: 8 });
  });
  it("YOLO class index round-trips all 32 classes", () => {
    for (let q = 1; q <= 4; q++)
      for (let p = 1; p <= 8; p++) {
        const idx = fdiToClassIdx(q, p);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(31);
        expect(classIdxToFdi(idx)).toEqual({ quadrant: q, position: p });
      }
  });
});
