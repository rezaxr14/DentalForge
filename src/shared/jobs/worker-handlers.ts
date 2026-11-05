/**
 * Worker contract v1 handlers (plan §10.1) — framework-free.
 *
 * Each handler is `(Request, deps, …ids) → Response`, so the whole HTTP
 * contract is testable with plain `Request` objects (no Next runtime) and the
 * route files stay one-liners. Expected conditions are problem+json DATA, never
 * thrown (plan §9.4 rule 2).
 */
import { artifactRefsInResult, parseResult } from "@/shared/contracts/jobs";
import { IngestEvalRunRequest, IngestMetricsRequest, IngestTracesRequest, RegisterModelRequest, type IngestTracesResponseT } from "@/shared/contracts/ingest";
import {
  ClaimJobsRequest,
  CompleteJobRequest,
  FailJobRequest,
  HeartbeatRequest,
  JobEventsRequest,
  PresignArtifactRequest,
  RegisterWorkerRequest,
  type ClaimJobsRequestT,
} from "@/shared/contracts/worker";
import { gateJobWrite, type ArtifactRecord, type OrgStore, type ScopedRepos } from "@/shared/db/repos";
import type { StorageAdapter } from "@/shared/storage/adapter";
import { authenticateWorker, requireWorker } from "./worker-auth";
import { json, jobWriteProblem, problem, readJson, validationProblem } from "./problem";
import { toClaimedJob } from "./mappers";
import { prepareTrace } from "./trace-ingest";
import { jobChannel, openWake, queueChannel, safePublish, type EventBus } from "@/shared/realtime/bus";
import { evalCaseRow } from "@/shared/lib/import/parse";

export const LEASE_SECONDS = 60;
export const POLL_INTERVAL_MS = 5000;
/** How often a waiting long-poll re-checks the queue when no wake-up bus is live (with one it polls only as a safety net, ADR-0015). */
export const CLAIM_POLL_MS = 750;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export interface WorkerDeps {
  store: OrgStore;
  storage: StorageAdapter;
  /** Optional wake-up bus (ADR-0015). Absent = database polling only. */
  bus?: EventBus;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function absolutize(url: string, req: Request): string {
  return url.startsWith("/") ? new URL(url, req.url).toString() : url;
}

function artifactKindFor(jobType: string): ArtifactRecord["kind"] {
  if (jobType === "tool.execute" || jobType === "trace.render_artifacts") return "tool_image";
  if (jobType === "agent.run") return "agent_image";
  return "report";
}

// ---- POST /register --------------------------------------------------------
export async function register(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = RegisterWorkerRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const r = parsed.data;
  const w = await auth.repos.registerWorker({
    name: r.name,
    runtime: r.runtime,
    // The full capability objects (versions/models) ride in `software` so the
    // capability ladder can match on declared models without a schema change.
    software: { ...r.software, declaredCapabilities: r.capabilities },
    capabilities: [...new Set(r.capabilities.map((c) => c.job))],
  });
  return json({
    workerId: w.id,
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseSeconds: LEASE_SECONDS,
    serverTime: new Date().toISOString(),
  });
}

// ---- POST /heartbeat -------------------------------------------------------
export async function heartbeat(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = HeartbeatRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const w = await auth.repos.heartbeatWorker(parsed.data.workerId);
  if (!w) return problem(403, "unknown_worker", "Unknown worker", "Register again to obtain a workerId.");
  // Renew BEFORE reaping: a worker that is alive and heartbeating keeps its jobs
  // even if its last event was a while ago (long evals, slow Colab cells).
  await auth.repos.renewLeases(w.id, LEASE_SECONDS);
  await auth.repos.reapJobs(); // lazy reaping rides on liveness traffic
  return json({ cancelJobIds: await auth.repos.cancelledJobIdsFor(w.id) });
}

// ---- POST /jobs/claim (long-poll) -----------------------------------------
async function claimLoop(repos: ScopedRepos, req: ClaimJobsRequestT, deps: WorkerDeps, orgId: string) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + req.waitMs;
  let lastBeat = now();
  // With a live bus, a parked long-poll is woken the moment a job is queued for this org and only polls the database as a
  // safety net; without one it polls every CLAIM_POLL_MS exactly as before. Subscribed BEFORE the first claim attempt.
  const wake = await openWake(deps.bus, queueChannel(orgId));
  try {
    for (;;) {
      await repos.reapJobs();
      const jobs = await repos.claimJobs(req.workerId, req.accepts, req.max, LEASE_SECONDS);
      if (jobs.length > 0) return jobs;
      const left = deadline - now();
      if (left <= 0) return [];
      // A parked long-poll is proof of life: keep the worker `online`.
      if (now() - lastBeat >= 10_000) {
        await repos.heartbeatWorker(req.workerId);
        lastBeat = now();
      }
      await wake.wait(CLAIM_POLL_MS, (ms) => sleep(Math.min(ms, left)));
    }
  } finally {
    await wake.close();
  }
}

export async function claim(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = ClaimJobsRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  // Claiming doubles as a heartbeat; also validates the worker belongs to this org.
  const w = await auth.repos.heartbeatWorker(parsed.data.workerId);
  if (!w) return problem(403, "unknown_worker", "Unknown worker", "Register again to obtain a workerId.");
  const jobs = await claimLoop(auth.repos, parsed.data, deps, auth.org.id);
  // Claiming changes status/attempt: tell anyone watching these jobs.
  await Promise.all(jobs.map((j) => safePublish(deps.bus, jobChannel(j.id))));
  return json({ jobs: jobs.map(toClaimedJob) });
}

// ---- POST /jobs/:id/events -------------------------------------------------
export async function postEvents(req: Request, deps: WorkerDeps, jobId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const worker = await requireWorker(req, auth);
  if (worker instanceof Response) return worker;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = JobEventsRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const res = await auth.repos.appendJobEvents(jobId, worker.id, parsed.data.events, LEASE_SECONDS);
  if (!res.ok) return jobWriteProblem(res.code);
  await safePublish(deps.bus, jobChannel(jobId));
  return json({
    accepted: res.value.accepted,
    leaseExtendedUntil: (res.value.leaseExpiresAt ?? new Date()).toISOString(),
  });
}

// ---- POST /jobs/:id/artifacts/presign -------------------------------------
export async function presignArtifact(req: Request, deps: WorkerDeps, jobId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const worker = await requireWorker(req, auth);
  if (worker instanceof Response) return worker;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = PresignArtifactRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const a = parsed.data;
  if (a.bytes > MAX_ARTIFACT_BYTES) {
    return problem(413, "invalid_request", "Artifact too large", `Limit is ${MAX_ARTIFACT_BYTES} bytes.`);
  }
  const job = await auth.repos.getJob(jobId);
  const gate = gateJobWrite(job, worker.id);
  if (!gate.ok) return jobWriteProblem(gate.code);

  let presigned;
  try {
    // Tenant-scoped key: the org id is the first path segment.
    presigned = await deps.storage.presignUpload({ name: a.name, mime: a.mime, bytes: a.bytes, sha256: a.sha256, prefix: auth.org.id });
  } catch {
    return problem(503, "unavailable", "Object storage is unavailable", "Artifact uploads need storage; retry later.", {}, { "retry-after": "30" });
  }
  const artifact = await auth.repos.createArtifact({
    kind: artifactKindFor(gate.value.type),
    storageKey: presigned.key,
    mime: a.mime,
    width: null,
    height: null,
    bytes: a.bytes,
    sha256: a.sha256,
    provenance: "worker_exact",
  });
  return json({ artifactId: artifact.id, uploadUrl: absolutize(presigned.uploadUrl, req), headers: presigned.headers });
}

// ---- POST /jobs/:id/complete ----------------------------------------------
export async function complete(req: Request, deps: WorkerDeps, jobId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const worker = await requireWorker(req, auth);
  if (worker instanceof Response) return worker;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = CompleteJobRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  const job = await auth.repos.getJob(jobId);
  if (!job) return jobWriteProblem("not_found");
  // Idempotent replay: the owner re-sending `complete` after a lost response.
  if (job.status === "succeeded" && job.claimedBy === worker.id) return json({ ok: true });

  const result = parseResult(job.type, parsed.data.result);
  if (!result.ok) return validationProblem(result.issues);

  const refs = [...new Set([...parsed.data.artifactIds, ...artifactRefsInResult(job.type, result.value)])];
  if (refs.length > 0) {
    const owned = await auth.repos.getArtifacts(refs);
    if (owned.length !== refs.length) {
      return validationProblem(["artifactIds: one or more artifacts do not exist in this organization"]);
    }
  }
  const res = await auth.repos.completeJob(jobId, worker.id, result.value, parsed.data.artifactIds);
  if (!res.ok) return jobWriteProblem(res.code);
  await safePublish(deps.bus, jobChannel(jobId));
  return json({ ok: true });
}

// ---- POST /jobs/:id/fail ---------------------------------------------------
export async function fail(req: Request, deps: WorkerDeps, jobId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const worker = await requireWorker(req, auth);
  if (worker instanceof Response) return worker;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = FailJobRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const res = await auth.repos.failJob(jobId, worker.id, parsed.data.error);
  if (!res.ok) return jobWriteProblem(res.code);
  // A failed job may go back to the queue (attempts remain): wake watchers AND parked claimers.
  await Promise.all([safePublish(deps.bus, jobChannel(jobId)), safePublish(deps.bus, queueChannel(auth.org.id))]);
  return json({ ok: true, attemptsRemaining: res.value.attemptsRemaining });
}

// ---- GET /images/:imageId?variant=original --------------------------------
export async function imageUrl(req: Request, deps: WorkerDeps, imageId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:read");
  if (auth instanceof Response) return auth;
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) return problem(404, "not_found", "Image not found");
  const variant = new URL(req.url).searchParams.get("variant") ?? "original";
  if (variant !== "original") {
    return problem(404, "not_found", "Image variant not available", "Only `original` is stored until the M7 variant pipeline lands.");
  }
  const image = await auth.repos.getImage(imageId);
  if (!image) return problem(404, "not_found", "Image not found");
  try {
    const ttl = 300;
    const url = await deps.storage.presignDownload(image.storageKey, ttl);
    // Live-run provenance (ADR-0025): a worker needs the dataset identity and the image's ground
    // truth to post a trace it just produced. The GT comes from an already-imported trace for this
    // image; `null` means "unknown", and the worker must skip ingestion rather than invent a
    // healthy scan.
    const dataset = (await auth.repos.listDatasets()).find((d) => d.id === image.datasetId);
    const traces = await auth.repos.listTraces({ imageId: image.id });
    const gtTrace =
      traces.find((t) => t.verified && t.groundTruth != null) ?? traces.find((t) => t.groundTruth != null);
    return json({
      url: absolutize(url, req),
      expiresInSeconds: ttl,
      width: image.width,
      height: image.height,
      imageId: image.id,
      sourceImageId: image.sourceImageId,
      datasetId: image.datasetId,
      dataset: dataset?.source ?? null,
      datasetName: dataset?.name ?? null,
      split: image.split,
      groundTruth: gtTrace?.groundTruth ?? null,
    });
  } catch {
    return problem(503, "unavailable", "Object storage is unavailable", undefined, {}, { "retry-after": "30" });
  }
}

// ---- GET /images?datasetId=&split=&limit=&offset= --------------------------
/**
 * One page of a dataset's images (ADR-0025 addendum §2). `eval.run` uses it to enumerate a split
 * without a database. Ordered by `sourceImageId` so paging is stable; `total` is the unpaged count.
 */
export async function listImages(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:read");
  if (auth instanceof Response) return auth;
  const q = new URL(req.url).searchParams;
  const datasetId = q.get("datasetId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(datasetId)) {
    return validationProblem(["datasetId: required, must be a dataset UUID"]);
  }
  const limitRaw = q.get("limit") ?? "100";
  const offsetRaw = q.get("offset") ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return validationProblem(["limit: integer 1-500"]);
  if (!Number.isInteger(offset) || offset < 0) return validationProblem(["offset: integer >= 0"]);
  const dataset = (await auth.repos.listDatasets()).find((d) => d.id === datasetId);
  if (!dataset) return problem(404, "not_found", "Dataset not found");
  // `split=` (empty) means "rows with no split"; an absent parameter means "no split filter".
  const split = q.has("split") ? q.get("split")! : null;
  const page = await auth.repos.listImagesPage({ datasetId, split, limit, offset });
  return json({
    images: page.images.map((i) => ({
      id: i.id,
      sourceImageId: i.sourceImageId,
      split: i.split ?? null,
      width: i.width,
      height: i.height,
    })),
    total: page.total,
  });
}

// ---- GET /traces/:id -------------------------------------------------------
/** The tool calls a re-execution needs (ADR-0025 addendum §2). No thoughts, no raw model output. */
export async function getWorkerTrace(req: Request, deps: WorkerDeps, traceId: string): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:read");
  if (auth instanceof Response) return auth;
  if (!/^[0-9a-f-]{36}$/i.test(traceId)) return problem(404, "not_found", "Trace not found");
  const trace = await auth.repos.getTrace(traceId);
  // Same answer for "unknown" and "another tenant's": no existence oracle.
  if (!trace) return problem(404, "not_found", "Trace not found");
  const turns = await auth.repos.listTraceTurns(traceId);
  return json({
    traceId: trace.id,
    imageId: trace.imageId,
    mode: trace.mode,
    turns: turns.map((t) => ({
      idx: t.idx,
      toolCalls: t.toolCalls.map((c) => ({
        idx: c.idx,
        toolName: c.toolName,
        args: c.args ?? {},
        ok: c.ok,
        error: c.error,
        artifactId: c.artifactId ?? null,
      })),
    })),
  });
}

// ---- Documented-but-deferred endpoints (plan §10.1) -----------------------
// ---- POST /models/register -------------------------------------------------
/** Upsert by (org, name, stage). Needs `jobs:write`; the ONNX artifact must be a `model` artifact of THIS org. */
export async function registerModel(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = RegisterModelRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const r = parsed.data;
  if (r.onnxArtifactId !== undefined) {
    // getArtifacts is org-scoped: another org's artifact is indistinguishable from a missing one.
    const [artifact] = await auth.repos.getArtifacts([r.onnxArtifactId]);
    if (!artifact || artifact.kind !== "model") {
      return validationProblem(["onnxArtifactId: no artifact of kind \"model\" with that id in this organization"]);
    }
  }
  const { model, created } = await auth.repos.registerModel({
    name: r.name,
    kind: r.kind,
    stage: r.stage,
    ...(r.hfPath !== undefined ? { hfPath: r.hfPath } : {}),
    ...(r.onnxArtifactId !== undefined ? { onnxArtifactId: r.onnxArtifactId } : {}),
    ...(r.meta !== undefined ? { meta: r.meta } : {}),
  });
  return json({ modelId: model.id, created, name: model.name, kind: model.kind, stage: model.stage });
}

// ---- POST /ingest/metrics --------------------------------------------------
/** Idempotent: re-sending a batch overwrites the same keys with the same values. Needs `jobs:write`. */
export async function ingestMetrics(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = IngestMetricsRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const r = parsed.data;
  const out = await auth.repos.ingestTraining({
    run: {
      kind: r.run.kind,
      name: r.run.name,
      ...(r.run.config !== undefined ? { config: r.run.config } : {}),
      ...(r.run.status !== undefined ? { status: r.run.status } : {}),
    },
    metrics: r.metrics,
    rewardSamples: r.rewardSamples,
  });
  return json({
    runId: out.run.id,
    runCreated: out.runCreated,
    status: out.run.status,
    metrics: { received: r.metrics.length, inserted: out.metricsInserted },
    rewardSamples: { received: r.rewardSamples.length, inserted: out.rewardSamplesInserted },
  });
}

// ---- POST /ingest/traces ---------------------------------------------------
/**
 * Verified traces, deduplicated by IDENTITY (dataset, image, cohort, mode) — ADR-0008/0012.
 * Structurally invalid requests are a 422 (client bug); everything state-dependent (unknown image,
 * already present) is a per-item outcome in a 200, so one bad trace never blocks the rest and a
 * retried batch is safe. Each trace commits atomically with its turns and tool calls. `jobs:write`.
 */
export async function ingestTraces(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = IngestTracesRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const { source, traces } = parsed.data;

  const datasetBySource = new Map<string, string>();
  for (const d of await auth.repos.listDatasets()) if (!datasetBySource.has(d.source)) datasetBySource.set(d.source, d.id);

  const results: IngestTracesResponseT["results"] = [];
  const counts = { inserted: 0, existing: 0, rejected: 0 };
  for (const [index, item] of traces.entries()) {
    const reject = (reason: "unknown_dataset" | "unknown_image" | "invalid_trace") => {
      counts.rejected += 1;
      results.push({ index, imageId: item.image_id, outcome: "rejected", reason });
    };
    const datasetId = datasetBySource.get(item.dataset);
    if (!datasetId) {
      reject("unknown_dataset");
      continue;
    }
    const prepared = prepareTrace(item, source, datasetId);
    if (!prepared) {
      reject("invalid_trace");
      continue;
    }
    const out = await auth.repos.ingestTrace(prepared);
    if (out.outcome === "rejected") {
      reject(out.reason);
      continue;
    }
    counts[out.outcome] += 1;
    results.push({
      index,
      imageId: item.image_id,
      outcome: out.outcome,
      traceId: out.trace.id,
      ...(out.outcome === "existing" ? { sameContent: out.sameContent } : {}),
    });
  }
  return json({ results, ...counts });
}

// ---- POST /ingest/eval-run -------------------------------------------------
/**
 * One chunk of an evaluation run (ADR-0013). The run is identified by the worker's `runKey`; its
 * dataset/split/provider/model come from the cases and must match on every chunk (409 `run_mismatch`
 * otherwise). Cases are upserted by (run, image_id), so a retried chunk is safe, and `n` and `summary`
 * are recomputed from ALL stored cases with the importer's own `summarizeEval`. `jobs:write`.
 */
export async function ingestEvalRun(req: Request, deps: WorkerDeps): Promise<Response> {
  const auth = await authenticateWorker(req, deps.store, "jobs:write");
  if (auth instanceof Response) return auth;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = IngestEvalRunRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const r = parsed.data;
  const first = r.cases[0]!;
  const out = await auth.repos.ingestEvalCases({
    runKey: r.runKey,
    run: { dataset: first.dataset, split: first.split, provider: first.provider, model: first.model, canonicalResize: r.canonicalResize },
    cases: r.cases.map((c) => {
      const row = evalCaseRow(c);
      return { ...row };
    }),
  });
  if (out.outcome === "run_mismatch") {
    const s = out.run;
    return problem(
      409,
      "run_mismatch",
      "Run key already used for a different run",
      `Run "${r.runKey}" is ${s.dataset}/${s.split}/${s.provider}/${s.model} (canonicalResize ${String(s.canonicalResize ?? false)}); this chunk says ${first.dataset}/${first.split}/${first.provider}/${first.model} (canonicalResize ${String(r.canonicalResize)}). Use a new runKey for a different run.`,
    );
  }
  return json({
    runId: out.run.id,
    runCreated: out.runCreated,
    dataset: out.run.dataset,
    split: out.run.split,
    provider: out.run.provider,
    model: out.run.model,
    n: out.run.n,
    cases: { received: r.cases.length, inserted: out.casesInserted },
    summary: out.run.summary,
  });
}

export function notImplemented(name: string): Response {
  return problem(501, "not_implemented", `${name} is not implemented in this build`, "Documented in the contract; scheduled after M8 (see ADR-0009).");
}
