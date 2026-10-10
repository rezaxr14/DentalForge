/**
 * User-facing job endpoints (session-authenticated, org-scoped):
 *   POST /api/jobs                create (can: job.create)
 *   GET  /api/jobs                list
 *   GET  /api/jobs/:id            status
 *   POST /api/jobs/:id/cancel     cancel (can: job.cancel)
 *   GET  /api/jobs/:id/events     SSE stream, or JSON page with ?format=json
 *
 * Framework-free like the worker handlers: the caller resolves the `actor`
 * (session + membership) and the handlers only decide.
 */
import { CreateJobRequest, JobStatus, parsePayload } from "@/shared/contracts/jobs";
import type { OrgStore } from "@/shared/db/repos";
import { can, type Role } from "@/shared/domain/auth";
import { json, problem, readJson, validationProblem } from "./problem";
import { toJobDto } from "./mappers";
import { DEFAULT_SSE, jobEventsPage, jobEventStream, type SseOptions } from "./sse";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

export interface UserDeps {
  store: OrgStore;
  actor: Actor | null;
  workerMode: "off" | "mock" | "live";
  sse?: Partial<Omit<SseOptions, "afterSeq">>;
}

const UUID = /^[0-9a-f-]{36}$/i;

function requireActor(deps: UserDeps): Actor | Response {
  return deps.actor ?? problem(401, "unauthorized", "Sign in required");
}

export async function createJob(req: Request, deps: UserDeps): Promise<Response> {
  const actor = requireActor(deps);
  if (actor instanceof Response) return actor;
  if (!can(actor.role, "job.create")) return problem(403, "forbidden", "Your role cannot enqueue jobs");
  if (deps.workerMode === "off") {
    return problem(503, "worker_integration_off", "Worker integration is disabled", "Set WORKER_MODE=live (or mock) to accept jobs.");
  }
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = CreateJobRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const payload = parsePayload(parsed.data.type, parsed.data.payload);
  if (!payload.ok) return validationProblem(payload.issues);

  const key = req.headers.get("idempotency-key");
  if (key !== null && (key.length === 0 || key.length > 128)) {
    return problem(400, "invalid_request", "Idempotency-Key must be 1–128 characters");
  }
  const job = await deps.store.scoped(actor.orgId).createJob({
    type: parsed.data.type,
    payload: payload.value,
    priority: parsed.data.priority,
    idempotencyKey: key,
    createdBy: actor.userId,
  });
  return json(toJobDto(job), 201, { location: `/api/jobs/${job.id}` });
}

export async function listJobs(req: Request, deps: UserDeps): Promise<Response> {
  const actor = requireActor(deps);
  if (actor instanceof Response) return actor;
  const q = new URL(req.url).searchParams;
  const status = q.get("status");
  if (status !== null && !JobStatus.safeParse(status).success) {
    return problem(400, "invalid_request", "Unknown status filter");
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.get("limit") ?? "25", 10) || 25));
  const repos = deps.store.scoped(actor.orgId);
  await repos.reapJobs();
  const jobs = await repos.listJobs({
    status: (status as ReturnType<typeof JobStatus.parse> | null) ?? undefined,
    type: q.get("type") ?? undefined,
    limit,
  });
  return json({ jobs: jobs.map(toJobDto) });
}

export async function getJob(_req: Request, deps: UserDeps, id: string): Promise<Response> {
  const actor = requireActor(deps);
  if (actor instanceof Response) return actor;
  if (!UUID.test(id)) return problem(404, "not_found", "Job not found");
  const repos = deps.store.scoped(actor.orgId);
  await repos.reapJobs();
  const job = await repos.getJob(id);
  return job ? json(toJobDto(job)) : problem(404, "not_found", "Job not found");
}

export async function cancelJob(_req: Request, deps: UserDeps, id: string): Promise<Response> {
  const actor = requireActor(deps);
  if (actor instanceof Response) return actor;
  if (!can(actor.role, "job.cancel")) return problem(403, "forbidden", "Your role cannot cancel jobs");
  if (!UUID.test(id)) return problem(404, "not_found", "Job not found");
  const job = await deps.store.scoped(actor.orgId).cancelJob(id);
  return job ? json(toJobDto(job)) : problem(404, "not_found", "Job not found");
}

export async function jobEvents(req: Request, deps: UserDeps, id: string): Promise<Response> {
  const actor = requireActor(deps);
  if (actor instanceof Response) return actor;
  if (!UUID.test(id)) return problem(404, "not_found", "Job not found");
  const url = new URL(req.url);
  const rawAfter = req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
  const after = Math.max(0, Number.parseInt(rawAfter, 10) || 0);
  const repos = deps.store.scoped(actor.orgId);

  if (url.searchParams.get("format") === "json") {
    const page = await jobEventsPage(repos, id, after);
    return page ? json(page) : problem(404, "not_found", "Job not found");
  }
  if (!(await repos.getJob(id))) return problem(404, "not_found", "Job not found");
  const stream = jobEventStream(repos, id, { ...DEFAULT_SSE, ...deps.sse, afterSeq: after, signal: req.signal });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
