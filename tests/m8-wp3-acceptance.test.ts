/**
 * WP3 acceptance, TypeScript side: the recording produced by the reference handlers must satisfy the
 * Zod contracts the server actually validates with.
 *
 * The pytest suite (`tests/python/test_wp3_acceptance.py`) validates the same file against
 * `docs/worker-openapi.json`. Two independent validators over one artifact: if a handler and a contract
 * drift apart, at least one side fails. The negative control proves neither side is vacuous.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AlScoreResult,
  EvalRunResult,
  JobEventsRequest,
  TraceRenderArtifactsResult,
} from "@/shared/contracts/worker";
import { IngestEvalRunRequest } from "@/shared/contracts/ingest";

interface RecordedJob {
  jobType: string;
  payload: Record<string, unknown>;
  events: { seq: number; type: string; data: unknown }[];
  result: unknown;
}

interface Recording {
  generatedBy: string;
  jobs: RecordedJob[];
  ingest: { path: string; body: unknown }[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "worker", "wp3-acceptance.json"), "utf8"),
) as Recording;

const RESULT_SCHEMAS: Record<string, z.ZodType> = {
  "eval.run": EvalRunResult,
  "al.score": AlScoreResult,
  "trace.render_artifacts": TraceRenderArtifactsResult,
};

/** Parse or fail with the issues, so a mismatch prints what is wrong instead of "expected true". */
function expectValid(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
}

describe("WP3 acceptance recording", () => {
  it("covers all three jobs and the event kinds that matter", () => {
    expect(new Set(fixture.jobs.map((j) => j.jobType))).toEqual(
      new Set(["eval.run", "al.score", "trace.render_artifacts"]),
    );
    const types = new Set(fixture.jobs.flatMap((j) => j.events.map((e) => e.type)));
    expect(types).toContain("progress");
    expect(types).toContain("partial");
    expect(types).toContain("log");
    expect(fixture.ingest.length).toBeGreaterThan(0);
  });

  it.each(fixture.jobs.map((j) => [j.jobType, j] as const))(
    "%s: every event stream is a valid JobEventsRequest",
    (_type, job) => {
      expectValid(JobEventsRequest, { events: job.events });
    },
  );

  it.each(fixture.jobs.map((j) => [j.jobType, j] as const))(
    "%s: the result matches its contract schema",
    (type, job) => {
      expectValid(RESULT_SCHEMAS[type]!, job.result);
    },
  );

  it("every recorded /ingest/eval-run body is a valid request", () => {
    for (const item of fixture.ingest) {
      expect(item.path).toBe("/ingest/eval-run");
      expectValid(IngestEvalRunRequest, item.body);
    }
  });

  // ------------------------------------------------------------------ negative controls
  it("negative control: a bogus event type is rejected by Zod", () => {
    const bad = { events: [{ seq: 1, type: "definitely_not_a_job_event", data: {} }] };
    expect(JobEventsRequest.safeParse(bad).success).toBe(false);
  });

  it("negative control: a result missing a required field is rejected by Zod", () => {
    const bad = { runId: "44444444-4444-4444-8444-444444444444", n: 1 }; // no `summary`
    expect(EvalRunResult.safeParse(bad).success).toBe(false);
  });

  it("negative control: an eval case with a missing metric is rejected by Zod", () => {
    const body = structuredClone(fixture.ingest[0]!.body) as { cases: Record<string, unknown>[] };
    delete body.cases[0]!.fdi_f1;
    expect(IngestEvalRunRequest.safeParse(body).success).toBe(false);
  });
});
