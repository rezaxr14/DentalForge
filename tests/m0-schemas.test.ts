import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EvalCase,
  Finding,
  Turn,
  UnverifiedTraceWrapper,
  VerifiedTrace,
} from "../src/shared/contracts/traces";

const FIX = join(__dirname, "..", "fixtures");

function load(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIX, rel), "utf-8"));
}

describe("M0: trace schemas validate sanitized real fixtures", () => {
  const files = readdirSync(join(FIX, "traces")).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);

  it.each(files)("validates fixtures/traces/%s", (file) => {
    const data = load(`traces/${file}`) as Record<string, unknown>;
    if (file.startsWith("unverified")) {
      const parsed = UnverifiedTraceWrapper.safeParse(data);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    } else {
      const parsed = VerifiedTrace.safeParse(data);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    }
  });

  it("with-tools fixture: tool-execution turns carry no raw_output/parsed", () => {
    const data = VerifiedTrace.parse(load("traces/verified_with_tools.json"));
    const toolTurns = data.turns.filter((t) => t.status === "tool_executed");
    expect(toolTurns.length).toBeGreaterThan(0);
    for (const t of toolTurns) {
      expect(t.raw_output).toBeUndefined();
      expect(t.parsed).toBeUndefined();
      expect(t.tool_calls_this_turn?.length).toBeGreaterThan(0);
    }
  });

  it("no-tools fixture: single turn, no status key", () => {
    const data = VerifiedTrace.parse(load("traces/verified_no_tools.json"));
    expect(data.turns).toHaveLength(1);
    const turn = data.turns[0];
    if (!turn) throw new Error("empty turns");
    expect(turn.status).toBeUndefined();
    expect(turn.raw_output).toBeDefined();
    expect(turn.parsed).toBeDefined();
  });

  it("healthy fixture: empty ground_truth and final_answer", () => {
    const data = VerifiedTrace.parse(load("traces/verified_healthy.json"));
    expect(data.ground_truth).toEqual([]);
    expect(data.final_answer).toEqual([]);
  });
});

describe("M0: eval schema validates sanitized real fixtures", () => {
  const files = readdirSync(join(FIX, "evals")).filter((f) => f.endsWith(".json"));

  it.each(files)("validates fixtures/evals/%s", (file) => {
    const parsed = EvalCase.safeParse(load(`evals/${file}`));
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it("eval findings carry raw_diagnosis alongside diagnosis", () => {
    const data = EvalCase.parse(load("evals/kimi_k3.json"));
    expect(data.ground_truth.length).toBeGreaterThan(0);
    const gt = data.ground_truth[0];
    if (!gt) throw new Error("empty gt");
    expect(gt.raw_diagnosis).toBeDefined();
  });
});

describe("M0: domain invariants from real data", () => {
  it("Finding rejects out-of-range FDI", () => {
    expect(Finding.safeParse({ quadrant: 5, tooth_position: 1, diagnosis: "Caries" }).success).toBe(false);
    expect(Finding.safeParse({ quadrant: 1, tooth_position: 9, diagnosis: "Caries" }).success).toBe(false);
  });

  it("Turn accepts a bare no-tools turn shape", () => {
    const parsed = Turn.safeParse({
      turn: 1,
      raw_output: '{"thought":"x"}',
      parsed: { thought: "x", final_answer: [] },
    });
    expect(parsed.success).toBe(true);
  });
});
