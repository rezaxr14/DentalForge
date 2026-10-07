/**
 * Authorization — the single pure `can()` gate (plan §5.2).
 *
 * Roles (per organization): admin > reviewer > annotator. All roles can read
 * the org's traces, evals and dashboards. Annotators cannot approve their own
 * work; reviewers cannot approve their own work either. Server actions and
 * route handlers call `can()`; UI hides controls with the same function.
 */
import { z } from "zod";

export const Role = z.enum(["admin", "annotator", "reviewer"]);
export type Role = z.infer<typeof Role>;

export const Action = z.enum([
  "trace.read",
  "eval.read",
  "quality.read",
  "annotation.create",
  "annotation.edit",
  "annotation.submit",
  "annotation.approve",
  "annotation.adjudicate",
  "review.decide",
  "export.create",
  "import.run",
  "member.invite",
  "member.changeRole",
  "member.remove",
  "worker.register",
  "worker.revokeToken",
  "job.create",
  "job.cancel",
  "dataset.manage",
  "org.manage",
]);
export type Action = z.infer<typeof Action>;

export interface Resource {
  /** Owner of the object being acted on (for self-approval checks). */
  authorId?: string;
  /** Actor attempting the action. */
  actorId?: string;
}

/**
 * Pure authorization gate. `resource` is required for self-approval actions
 * (`annotation.approve`, `review.decide`): approving your own work is
 * forbidden regardless of role.
 */
export function can(role: Role, action: Action, resource?: Resource): boolean {
  switch (action) {
    case "trace.read":
    case "eval.read":
    case "quality.read":
      return true; // all member roles read org data

    case "annotation.create":
    case "annotation.edit":
    case "annotation.submit":
      return role === "admin" || role === "annotator" || role === "reviewer";

    case "annotation.approve":
    case "annotation.adjudicate":
    case "review.decide":
      if (role !== "admin" && role !== "reviewer") return false;
      // Nobody approves their own work (plan §5.2, §11.3 review workflow).
      if (resource?.authorId !== undefined && resource.authorId === resource.actorId) return false;
      return true;

    case "export.create":
    case "job.create":
      return role === "admin" || role === "annotator" || role === "reviewer";

    case "job.cancel":
    case "dataset.manage":
      return role === "admin" || role === "reviewer";

    case "import.run":
    case "member.invite":
    case "member.changeRole":
    case "member.remove":
    case "worker.register":
    case "worker.revokeToken":
    case "org.manage":
      return role === "admin";
  }
}

/** Rank helper for UI display / role comparisons. Higher = more privilege. */
export function roleRank(role: Role): number {
  return role === "admin" ? 3 : role === "reviewer" ? 2 : 1;
}
