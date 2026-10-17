/**
 * Server-side rules for persisting an annotation set (ADR-0019). Pure: no DB, no clock, no React.
 *
 * Both stores (MemoryStore, DrizzleOrgStore) call `applyOpsToSet` and `transitionTarget`, so the rules that decide
 * what an op batch may do cannot drift between them (same pattern as `gateJobWrite`). The ops are the editor's own
 * history `Command`s, applied with the editor's own tolerant `apply`: unknown ids and duplicate creates are no-ops, which
 * is also what makes a retried batch (response lost, client replays) converge instead of failing.
 */
import { z } from "zod";
import { Annotation, type AnnotationStatus } from "@/shared/contracts/labels";
import { can, type Action, type Role } from "../auth";
import { apply, type Command } from "./history";

export const MAX_OPS_PER_REQUEST = 200;
export const MAX_BOXES_PER_SET = 500;
/** Batches nest only one level in practice (a drag, a mirror); the cap keeps a hostile body from recursing deeply. */
const MAX_BATCH_DEPTH = 4;

// ---------------------------------------------------------------- wire schema

const Fields = Annotation.pick({ bbox: true, fdi_quadrant: true, fdi_position: true, pathology: true }).partial();
/** `after` is what the server applies: strict, so a client cannot smuggle `status`, `author_id`, `source`, … in a patch. */
const PatchAfter = Fields.strict();
/** `before` is only the editor's undo data; the server ignores it, so it may carry `status` like the editor's patches do. */
const PatchBefore = Fields.extend({ status: Annotation.shape.status.optional() }).strict();

export const CommandSchema: z.ZodType<Command, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), annotation: Annotation, index: z.number().int().min(0) }).strict(),
    z.object({ type: z.literal("delete"), annotation: Annotation, index: z.number().int().min(0) }).strict(),
    z.object({ type: z.literal("update"), id: z.string().min(1), before: PatchBefore, after: PatchAfter }).strict(),
    z.object({ type: z.literal("setLabel"), id: z.string().min(1), before: PatchBefore, after: PatchAfter }).strict(),
    z.object({ type: z.literal("batch"), label: z.string().max(200), commands: z.array(CommandSchema) }).strict(),
  ]),
) as z.ZodType<Command, unknown>;

// ---------------------------------------------------------------- applying ops

export type OpsResult =
  | { ok: true; annotations: Annotation[]; changed: boolean }
  | { ok: false; message: string };

export interface OpsContext {
  /** Pixel space of the stored boxes = the image row's width/height (original dataset dimensions). */
  width: number;
  height: number;
  actorId: string;
  /**
   * Canonical form of a box as the store returns it (float32 coordinates). Applied to the result BEFORE validation and
   * the `changed` comparison, so a replayed batch whose values differ from the stored ones only by float32 rounding
   * is a no-op instead of a version bump.
   */
  normalize?: (a: Annotation) => Annotation;
}

/** Flatten batches into leaf commands; `null` when nesting is too deep. */
export function leafCommands(ops: readonly Command[], depth = 0): Command[] | null {
  if (depth > MAX_BATCH_DEPTH) return null;
  const out: Command[] = [];
  for (const c of ops) {
    if (c.type === "batch") {
      const inner = leafCommands(c.commands, depth + 1);
      if (!inner) return null;
      out.push(...inner);
    } else out.push(c);
  }
  return out;
}

/**
 * Slack, in image pixels, on the inside-the-image rule for human boxes (ADR-0020). The editor clamps a dragged box to the
 * edge in float64 (x + w === width), but boxes are validated in their canonical float32 form where x and w are rounded
 * independently, so x + w can land up to ~1e-3 px past the edge: 671 of 18,862 random edge-touching boxes failed without
 * this slack. A hundredth of a pixel is far below anything a person can draw and far above that rounding.
 */
export const BOUNDS_EPSILON_PX = 0.01;

const finite4 = (b: readonly number[]): boolean => b.length === 4 && b.every((n) => Number.isFinite(n));

function sameList(a: readonly Annotation[], b: readonly Annotation[]): boolean {
  return a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
}

/**
 * Apply an already schema-validated op batch to the current boxes.
 *
 * Rules (each has a test that fails without it):
 *  - at most MAX_OPS_PER_REQUEST leaf commands and MAX_BOXES_PER_SET boxes afterwards;
 *  - a created box is a draft authored by the signed-in user (no spoofing someone else's authorship or an approved status);
 *  - every box has finite coordinates and a positive size; only `human` boxes must lie inside the image.
 *    Model predictions legitimately overhang the image edge (5 of the 32 stored predictions of fixture 1 do, by up to 56 px),
 *    so rejecting them would be the ADR-0014 bug again: tolerant for model output, strict for human ground truth.
 */
export function applyOpsToSet(current: readonly Annotation[], ops: readonly Command[], ctx: OpsContext): OpsResult {
  const leaves = leafCommands(ops);
  if (!leaves) return { ok: false, message: "ops are nested too deeply" };
  if (leaves.length > MAX_OPS_PER_REQUEST) {
    return { ok: false, message: `at most ${MAX_OPS_PER_REQUEST} ops per request (got ${leaves.length})` };
  }
  for (const c of leaves) {
    if (c.type !== "create") continue;
    if (c.annotation.author_id !== ctx.actorId) return { ok: false, message: "a created box must be authored by the signed-in user" };
    if (c.annotation.status !== "draft") return { ok: false, message: "a created box must start as a draft" };
    if (c.annotation.model_id !== undefined && c.annotation.source !== "model") {
      return { ok: false, message: "only a model box can name a model" };
    }
  }

  const applied = ops.reduce<Annotation[]>(apply, current.slice());
  const next = ctx.normalize ? applied.map(ctx.normalize) : applied;
  if (next.length > MAX_BOXES_PER_SET) return { ok: false, message: `a set holds at most ${MAX_BOXES_PER_SET} boxes` };

  const seen = new Set<string>();
  for (const a of next) {
    if (seen.has(a.id)) return { ok: false, message: `duplicate box id ${a.id}` };
    seen.add(a.id);
    const [x, y, w, h] = a.bbox;
    if (!finite4(a.bbox) || w <= 0 || h <= 0) return { ok: false, message: `box ${a.id} has an invalid size` };
    if (a.source === "human" && (x < 0 || y < 0 || x + w > ctx.width + BOUNDS_EPSILON_PX || y + h > ctx.height + BOUNDS_EPSILON_PX)) {
      return { ok: false, message: `box ${a.id} lies outside the ${ctx.width}x${ctx.height} image` };
    }
  }
  return { ok: true, annotations: next, changed: !sameList(current, next) };
}

// ---------------------------------------------------------------- set state machine

export type SetTransition = "submit" | "approve" | "reject" | "reopen";

const TRANSITIONS: Record<SetTransition, { from: AnnotationStatus; to: AnnotationStatus; action: Action }> = {
  submit: { from: "draft", to: "submitted", action: "annotation.submit" },
  approve: { from: "submitted", to: "approved", action: "review.decide" },
  reject: { from: "submitted", to: "rejected", action: "review.decide" },
  reopen: { from: "rejected", to: "draft", action: "annotation.edit" },
};

/** The state a transition leads to, or `null` when the set is not in the state the transition starts from. */
export function transitionTarget(from: AnnotationStatus, t: SetTransition): AnnotationStatus | null {
  const rule = TRANSITIONS[t];
  return rule.from === from ? rule.to : null;
}

/**
 * Role + self-review gate for a transition. Deciding is `review.decide`, which `can()` refuses to the author of the work.
 * A set has several contributors, so the actor counts as its author when they are the assignee or drew any box in it.
 */
export function canTransition(
  role: Role,
  t: SetTransition,
  actorId: string,
  assigneeId: string | null,
  annotations: readonly Annotation[],
): boolean {
  const action = TRANSITIONS[t].action;
  if (action !== "review.decide") return can(role, action);
  // The author of record is the actor when they drew any box, else the assignee; `can()` then refuses actor === author,
  // which also covers an assignee who drew nothing (the fallback IS the actor).
  const drewABox = annotations.some((a) => a.author_id === actorId);
  return can(role, action, { authorId: drewABox ? actorId : (assigneeId ?? "no-assignee"), actorId });
}
