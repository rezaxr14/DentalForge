/**
 * The TypeScript half of the WP3 acceptance check: the recorded worker bytes must parse with the
 * same Zod contract the server uses, and a mutated copy must not.
 *
 * The fixture is written by `examples/python-worker/record_wp3_events.py` from the reference
 * worker's real `JobContext.emit` payloads. `tests/python/test_worker_openapi.py` validates the same
 * bytes against `docs/worker-openapi.json`; two independent generators over one recording means a
 * shape change cannot pass on one side only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AlScoreResult,
  EvalRunResult,
  JobEventsRequest,
  TraceRenderArtifactsResult,
} from "@/shared/contracts/worker";

type Stream = { jobType: string; events: unknown[]; result: unknown };
type Recorded = { contractVersion: string; streams: Stream[] };

const recorded = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "worker", "wp3-recorded-events.json"), "utf8"),
) as Recorded;

const RESULTS = {
  "eval.run": EvalRunResult,
  "al.score": AlScoreResult,
  "trace.render_artifacts": TraceRenderArtifactsResult,
} as const;

function stream(jobType: keyof typeof RESULTS): Stream {
  const found = recorded.streams.find((s) => s.jobType === jobType);
  if (!found) throw new Error(`no recorded stream for ${jobType}`);
  return found;
}

describe("recorded WP3 worker output", () => {
  it("covers the three handlers", () => {
    expect(recorded.streams.map((s) => s.jobType).sort()).toEqual(Object.keys(RESULTS).sort());
  });

  it.each(Object.keys(RESULTS) as (keyof typeof RESULTS)[])("%s events parse as JobEventsRequest", (jobType) => {
    const s = stream(jobType);
    expect(s.events.length).toBeGreaterThan(0);
    const parsed = JobEventsRequest.safeParse({ events: s.events });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it.each(Object.keys(RESULTS) as (keyof typeof RESULTS)[])("%s result parses as its contract", (jobType) => {
    const parsed = RESULTS[jobType].safeParse(stream(jobType).result);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    // Zod strips unknown keys by default; the contract is `additionalProperties: false`, so a clean
    // round-trip is part of the check (this is how the leaked `sha256` would have been caught here).
    expect(parsed.data).toEqual(stream(jobType).result);
  });

  it("negative control: an event with a type outside the enum fails", () => {
    const events = structuredClone(stream("al.score").events) as { type: string }[];
    events[0]!.type = "definitely-not-an-event-type";
    expect(JobEventsRequest.safeParse({ events }).success).toBe(false);
  });

  it("a result carrying a field the contract does not define is stripped, never echoed", () => {
    const bad = structuredClone(stream("trace.render_artifacts").result) as {
      artifacts: Record<string, unknown>[];
    };
    bad.artifacts[0]!.sha256 = "0".repeat(64);
    const parsed = TraceRenderArtifactsResult.safeParse(bad);
    expect(parsed.success).toBe(true);
    // `additionalProperties: false` in the generated OpenAPI; the server's Zod parse strips instead
    // of rejecting, so the assertion is that the field never survives to the stored result. This is
    // the exact field the render handler used to leak.
    expect(parsed.data).not.toEqual(bad);
  });
});
