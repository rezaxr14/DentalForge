/**
 * Worker contract v1 handlers (plan §10.1) — framework-free.
 *
 * Each handler is `(Request, deps, …ids) → Response`, so the whole HTTP
 * contract is testable with plain `Request` objects (no Next runtime) and the
 * route files stay one-liners. Expected conditions are problem+json DATA, never
 * thrown (plan §9.4 rule 2).
 */
import { artifactRefsInResult, parseResult } from "@/shared/contracts/jobs";
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

export const LEASE_SECONDS = 60;
export const POLL_INTERVAL_MS = 5000;
/** How often a waiting long-poll re-checks the queue (DB-poll; Redis is optional, plan §5.1). */
export const CLAIM_POLL_MS = 750;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export interface WorkerDeps {
  store: OrgStore;
  storage: StorageAdapter;
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
async function claimLoop(repos: ScopedRepos, req: ClaimJobsRequestT, deps: WorkerDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + req.waitMs;
  let lastBeat = now();
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
    await sleep(Math.min(CLAIM_POLL_MS, left));
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
  const jobs = await claimLoop(auth.repos, parsed.data, deps);
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
    return json({ url: absolutize(url, req), expiresInSeconds: ttl, width: image.width, height: image.height });
  } catch {
    return problem(503, "unavailable", "Object storage is unavailable", undefined, {}, { "retry-after": "30" });
  }
}

// ---- Documented-but-deferred endpoints (plan §10.1) -----------------------
export function notImplemented(name: string): Response {
  return problem(501, "not_implemented", `${name} is not implemented in this build`, "Documented in the contract; scheduled after M8 (see ADR-0009).");
}
