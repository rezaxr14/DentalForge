/**
 * LabelForge persistence endpoints (ADR-0019), session-authenticated and org-scoped:
 *   GET  /api/labels/:image              the set, read-only (404 until someone opened it)
 *   POST /api/labels/:image/open         register the image and create the empty draft set (idempotent)
 *   POST /api/labels/:image/ops          { baseVersion, ops }  → 200 set | 409 conflict (+ current set) | 422
 *   POST /api/labels/:image/transition   { transition, baseVersion, reason? } submit | approve | reject | reopen
 *
 * Framework-free like the job handlers: the caller resolves the actor (session + membership) and the store.
 * The organisation always comes from the actor, never from the request.
 */
import { z } from "zod";
import type { AnnotationSetSnapshot, OpenImageInput, OrgStore, TransitionOutcome } from "@/shared/db/repos";
import { can } from "@/shared/domain/auth";
import { CommandSchema, MAX_OPS_PER_REQUEST } from "@/shared/domain/editing/persist";
import { json, problem, validationProblem } from "@/shared/jobs/problem";
import type { Actor } from "@/shared/jobs/user-handlers";
import type { SetDto } from "./dto";
import { resolveFixtureImage } from "./image-source";

export const MAX_BODY_BYTES = 256 * 1024;

export interface LabelDeps {
  store: OrgStore;
  actor: Actor | null;
  /** Test seam; defaults to the fixtures. */
  resolveImage?: (id: string) => OpenImageInput | null;
}

export type { SetDto };

export function toSetDto(s: AnnotationSetSnapshot, viewer: Actor): SetDto {
  return {
    viewer: { userId: viewer.userId, role: viewer.role },
    version: s.set.version,
    state: s.set.state,
    assigneeId: s.set.assigneeId,
    submittedAt: s.set.submittedAt ? s.set.submittedAt.toISOString() : null,
    image: { width: s.image.width, height: s.image.height },
    annotations: s.annotations,
  };
}

const OpsRequest = z
  .object({
    baseVersion: z.number().int().min(1),
    ops: z.array(CommandSchema).max(MAX_OPS_PER_REQUEST),
  })
  .strict();

const TransitionRequest = z
  .object({
    transition: z.enum(["submit", "approve", "reject", "reopen"]),
    baseVersion: z.number().int().min(1),
    reason: z.string().max(2000).optional(),
  })
  .strict();

type Resolved = { actor: Actor; image: OpenImageInput };

function resolve(deps: LabelDeps, imageId: string): Resolved | Response {
  if (!deps.actor) return problem(401, "unauthorized", "Sign in required");
  const image = (deps.resolveImage ?? resolveFixtureImage)(imageId);
  if (!image) return problem(404, "not_found", "Unknown image");
  return { actor: deps.actor, image };
}

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  // Cookie-authenticated writes accept only JSON: a cross-site <form> can send text/plain but not application/json
  // without a CORS preflight, so this holds even if SameSite handling ever changes.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return { ok: false, res: problem(415, "invalid_request", "Content-Type must be application/json") };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, res: problem(413, "invalid_request", "Request body too large") };
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      return { ok: false, res: problem(413, "invalid_request", "Request body too large") };
    }
    return { ok: true, value: text.length === 0 ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, res: problem(400, "invalid_request", "Malformed JSON body") };
  }
}

function outcomeResponse(o: TransitionOutcome, actor: Actor): Response {
  switch (o.kind) {
    case "ok":
      return json(toSetDto(o.snapshot, actor));
    case "conflict":
      return problem(
        409,
        "conflict",
        o.reason === "version" ? "The set changed since you loaded it" : "The set is no longer a draft",
        o.reason === "version"
          ? "Rebase your edits onto the returned set and resend."
          : "Reopen it (after a rejection) before editing.",
        { reason: o.reason, set: toSetDto(o.snapshot, actor) },
      );
    case "invalid":
      return problem(422, "validation_failed", "The edit was refused", o.message);
    case "forbidden":
      return problem(403, "forbidden", "Your role cannot make this decision on this set");
    case "not_found":
      return problem(404, "not_found", "Image not opened yet", "POST /api/labels/:image/open first.");
  }
}

export async function getSet(deps: LabelDeps, imageId: string): Promise<Response> {
  const r = resolve(deps, imageId);
  if (r instanceof Response) return r;
  const snap = await deps.store.scoped(r.actor.orgId).getAnnotationSet(r.image);
  return snap ? json(toSetDto(snap, r.actor)) : problem(404, "not_found", "Image not opened yet", "POST /api/labels/:image/open first.");
}

export async function openSet(deps: LabelDeps, imageId: string): Promise<Response> {
  const r = resolve(deps, imageId);
  if (r instanceof Response) return r;
  if (!can(r.actor.role, "annotation.create")) return problem(403, "forbidden", "Your role cannot open images for labelling");
  const snap = await deps.store.scoped(r.actor.orgId).openAnnotationSet({ ...r.image, assigneeId: r.actor.userId });
  return json(toSetDto(snap, r.actor));
}

export async function postOps(req: Request, deps: LabelDeps, imageId: string): Promise<Response> {
  const r = resolve(deps, imageId);
  if (r instanceof Response) return r;
  if (!can(r.actor.role, "annotation.edit")) return problem(403, "forbidden", "Your role cannot edit annotations");
  const body = await readBody(req);
  if (!body.ok) return body.res;
  const parsed = OpsRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const out = await deps.store.scoped(r.actor.orgId).applyAnnotationOps({
    source: r.image.source,
    sourceImageId: r.image.sourceImageId,
    baseVersion: parsed.data.baseVersion,
    ops: parsed.data.ops,
    actorId: r.actor.userId,
  });
  return outcomeResponse(out, r.actor);
}

export async function postTransition(req: Request, deps: LabelDeps, imageId: string): Promise<Response> {
  const r = resolve(deps, imageId);
  if (r instanceof Response) return r;
  const body = await readBody(req);
  if (!body.ok) return body.res;
  const parsed = TransitionRequest.safeParse(body.value);
  if (!parsed.success) return validationProblem(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const out = await deps.store.scoped(r.actor.orgId).transitionAnnotationSet({
    source: r.image.source,
    sourceImageId: r.image.sourceImageId,
    baseVersion: parsed.data.baseVersion,
    transition: parsed.data.transition,
    actorId: r.actor.userId,
    role: r.actor.role,
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
  });
  return outcomeResponse(out, r.actor);
}
