/**
 * OpenAPI 3.1 document for worker contract v1, GENERATED from the zod schemas
 * (plan §10: "publish the schema … generated from the zod contracts"). Zod 4
 * ships `z.toJSONSchema`, so there is no extra dependency and the document can
 * never drift from what the handlers actually validate. Served at
 * `GET /api/worker/v1/openapi.json`; `docs/worker-contract.md` is rendered from
 * it and a test fails if either committed file is stale.
 */
import { z } from "zod";
import { JOB_DEFINITIONS, JobDto, JobEventDto, JobEventsPage, CreateJobRequest } from "./jobs";
import {
  CONTRACT_VERSION,
  ClaimJobsRequest,
  ClaimJobsResponse,
  CompleteJobRequest,
  CompleteJobResponse,
  FailJobRequest,
  FailJobResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  JobEventsRequest,
  JobEventsResponse,
  PresignArtifactRequest,
  PresignArtifactResponse,
  ProblemDetails,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
} from "./worker";

type Json = Record<string, unknown>;

/** Component schemas live inside the document, so the per-schema `$schema` marker is noise. */
function schemaOf(s: z.ZodType, io: "input" | "output"): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, target: "draft-2020-12" }) as Json;
  void _drop;
  return rest;
}
const input = (s: z.ZodType): Json => schemaOf(s, "input");
const output = (s: z.ZodType): Json => schemaOf(s, "output");

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({ "application/json": { schema: ref(name) } });
const problemRes = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ref("ProblemDetails") } },
});

const contractHeader = { name: "X-Contract-Version", in: "header", required: true, schema: { type: "integer", const: CONTRACT_VERSION } };
const workerHeader = {
  name: "X-Worker-Id",
  in: "header",
  required: true,
  description: "The workerId returned by /register. Fences job writes to the lease holder (ADR-0009).",
  schema: { type: "string", format: "uuid" },
};
const jobIdParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

export function buildWorkerOpenApi(): Json {
  const schemas: Record<string, Json> = {
    ProblemDetails: output(ProblemDetails),
    RegisterWorkerRequest: input(RegisterWorkerRequest),
    RegisterWorkerResponse: output(RegisterWorkerResponse),
    HeartbeatRequest: input(HeartbeatRequest),
    HeartbeatResponse: output(HeartbeatResponse),
    ClaimJobsRequest: input(ClaimJobsRequest),
    ClaimJobsResponse: output(ClaimJobsResponse),
    JobEventsRequest: input(JobEventsRequest),
    JobEventsResponse: output(JobEventsResponse),
    PresignArtifactRequest: input(PresignArtifactRequest),
    PresignArtifactResponse: output(PresignArtifactResponse),
    CompleteJobRequest: input(CompleteJobRequest),
    CompleteJobResponse: output(CompleteJobResponse),
    FailJobRequest: input(FailJobRequest),
    FailJobResponse: output(FailJobResponse),
    CreateJobRequest: input(CreateJobRequest),
    Job: output(JobDto),
    JobEvent: output(JobEventDto),
    JobEventsPage: output(JobEventsPage),
  };
  for (const [type, def] of Object.entries(JOB_DEFINITIONS)) {
    const pascal = type.replace(/(^|[._])(\w)/g, (_m, _s, c: string) => c.toUpperCase());
    schemas[`${pascal}Payload`] = input(def.payload);
    schemas[`${pascal}Result`] = output(def.result);
  }

  const post = (summary: string, req: string, res: string, extraParams: Json[] = [], extraResponses: Json = {}) => ({
    post: {
      summary,
      parameters: [contractHeader, ...extraParams],
      requestBody: { required: true, content: content(req) },
      responses: {
        "200": { description: "OK", content: content(res) },
        "400": problemRes("Malformed request or missing header"),
        "401": problemRes("Missing, invalid or revoked worker token"),
        "403": problemRes("Insufficient scope or unknown worker"),
        "422": problemRes("Validation failed"),
        "426": problemRes("Unsupported contract version"),
        "503": problemRes("Database unavailable — retry after the Retry-After delay"),
        ...extraResponses,
      },
      security: [{ workerToken: [] }],
    },
  });
  /** Lease fence: refused when you no longer hold the job. */
  const jobConflict = { "409": problemRes("job_not_owner | job_cancelled | job_terminal — stop working on this job") };

  const notImpl = (summary: string) => ({
    post: {
      summary,
      "x-implemented": false,
      responses: { "501": problemRes("Documented in v1, not implemented in this build (ADR-0009)") },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "TraceForge Worker Contract",
      version: String(CONTRACT_VERSION),
      description:
        "Pull-based, outbound-only worker API. Workers poll; the app never calls a worker. " +
        "Errors are RFC 9457 application/problem+json. Job-write endpoints require X-Worker-Id.",
    },
    servers: [{ url: "/api/worker/v1" }],
    components: {
      securitySchemes: { workerToken: { type: "http", scheme: "bearer", bearerFormat: "tf_wrk_<random>" } },
      schemas,
    },
    paths: {
      "/register": post("Register (upsert by name) and obtain a workerId", "RegisterWorkerRequest", "RegisterWorkerResponse"),
      "/heartbeat": post("Liveness; returns jobs cancelled while you held them", "HeartbeatRequest", "HeartbeatResponse"),
      "/jobs/claim": post("Long-poll (≤20 s) for jobs; leases them for `leaseSeconds`", "ClaimJobsRequest", "ClaimJobsResponse"),
      "/jobs/{id}/events": post("Append events (idempotent on seq); extends the lease", "JobEventsRequest", "JobEventsResponse", [jobIdParam, workerHeader], jobConflict),
      "/jobs/{id}/artifacts/presign": post("Presign an artifact upload", "PresignArtifactRequest", "PresignArtifactResponse", [jobIdParam, workerHeader], jobConflict),
      "/jobs/{id}/complete": post("Complete a job (idempotent for the lease holder)", "CompleteJobRequest", "CompleteJobResponse", [jobIdParam, workerHeader], jobConflict),
      "/jobs/{id}/fail": post("Fail a job; retryable failures requeue while attempts remain", "FailJobRequest", "FailJobResponse", [jobIdParam, workerHeader], jobConflict),
      "/images/{imageId}": {
        get: {
          summary: "Short-lived presigned download URL for an image (variant: original)",
          parameters: [
            contractHeader,
            { name: "imageId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "variant", in: "query", required: false, schema: { type: "string", enum: ["original"], default: "original" } },
          ],
          responses: { "200": { description: "OK" }, "404": problemRes("Unknown image or variant") },
          security: [{ workerToken: [] }],
        },
      },
      "/models/register": notImpl("Register a model checkpoint"),
      "/ingest/eval-run": notImpl("Ingest eval cases"),
      "/ingest/traces": notImpl("Ingest verified traces"),
      "/ingest/metrics": notImpl("Ingest training metrics"),
    },
    "x-job-types": Object.fromEntries(
      Object.keys(JOB_DEFINITIONS).map((t) => {
        const pascal = t.replace(/(^|[._])(\w)/g, (_m, _s, c: string) => c.toUpperCase());
        return [t, { payload: ref(`${pascal}Payload`), result: ref(`${pascal}Result`) }];
      }),
    ),
  };
}
