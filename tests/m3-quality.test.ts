import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VerifiedTrace } from "../src/shared/contracts/traces";
import { mergeReports, scanTrace } from "../src/shared/domain/quality";

const goldens = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "goldens", "m3_quality.json"), "utf-8"),
) as {
  n_traces: number;
  overall_tools: Record<string, number>;
  overall_statuses: Record<string, number>;
  overall_unknown_tools: Record<string, number>;
  perturb_tiers: Record<string, number>;
  per_file: Record<string, { n: number; directive_leak: number; healthy_false_positives: number }>;
};

describe("M3: quality stats shape", () => {
  it("covers all 12 verified files and 5454 trace rows (incl. hybrid dupes)", () => {
    expect(goldens.n_traces).toBe(5454);
    expect(Object.keys(goldens.per_file)).toHaveLength(12);
  });
  it("directive leak is systemic (100% of files)", () => {
    for (const [file, s] of Object.entries(goldens.per_file)) {
      expect(s.directive_leak, file).toBe(s.n);
    }
  });
  it("status taxonomy matches M0 observations + recovery/tool-failed states", () => {
    const st = goldens.overall_statuses;
    expect(st.tool_executed).toBeGreaterThan(30000);
    expect(st.rejected_final_answer).toBe(69);
    expect(st.unparseable_retry).toBe(313);
    expect(st.invalid_tool_format).toBe(177);
    expect(st.tool_all_failed).toBe(75);
    expect(st.unparseable_recovery_attempt).toBe(23);
    expect(st["<none>"]).toBe(2727);
  });
  it("unknown tool names quantified", () => {
    expect(goldens.overall_unknown_tools).toEqual({
      final_answer: 74, localize_tooth: 2, localize: 1, "localize tooth 13": 1,
    });
  });
  it("perturb tiers near the documented 45/25/30 split", () => {
    const { small, big } = goldens.perturb_tiers as { small: number; big: number };
    expect(small).toBe(3978);
    expect(big).toBe(4597);
    expect(big / (small + big)).toBeCloseTo(0.536, 2);
  });
});

describe("M3: TS scanner parity on committed fixtures", () => {
  it("scanner reproduces tool/status counts of each fixture trace", () => {
    const dir = join(__dirname, "..", "fixtures", "traces");
    const scans = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("unverified"))
      .map((f) => {
        const t = VerifiedTrace.parse(JSON.parse(readFileSync(join(dir, f), "utf-8")));
        return scanTrace({ ...t, messages: t.messages });
      });
    const report = mergeReports(scans);
    expect(report.nTraces).toBe(scans.length);
    // every fixture tool name must be known except none — fixtures are clean samples
    expect(report.unknownTools).toEqual({});
    expect(Object.values(report.tools).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
