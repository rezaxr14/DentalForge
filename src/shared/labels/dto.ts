/**
 * The set the label API returns (ADR-0019, ADR-0020), as a schema so the browser client can check what it received instead
 * of trusting a cast. The server's handlers build the same shape; a handler test parses their real output with `.strict()`
 * so an added or renamed field cannot drift away from this file unnoticed.
 */
import { z } from "zod";
import { Annotation, AnnotationStatus } from "@/shared/contracts/labels";
import { Role } from "@/shared/domain/auth";

const ViewerSchema = z.object({ userId: z.string().min(1), role: Role });

export const SetDtoSchema = z.object({
  /** The caller's own id and role in the active org (ADR-0020). */
  viewer: ViewerSchema,
  version: z.number().int().min(1),
  state: AnnotationStatus,
  assigneeId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  image: z.object({ width: z.number().positive(), height: z.number().positive() }),
  annotations: z.array(Annotation),
});
export type SetDto = z.infer<typeof SetDtoSchema>;

/** `GET /api/labels`: every opened set of the active org, read-only (the Review, Export and queue pages). Unopened images are absent. */
export const ListDtoSchema = z.object({
  viewer: ViewerSchema,
  sets: z.array(z.object({ imageId: z.string().min(1), set: SetDtoSchema })),
});
export type ListDto = z.infer<typeof ListDtoSchema>;
export type Viewer = SetDto["viewer"];

/** One decision on a set (ADR-0023): who did what, when, and the reason they gave. `version` is the set's version after it. */
export const DecisionDtoSchema = z.object({
  transition: z.enum(["submit", "approve", "reject", "reopen"]),
  actorId: z.string().nullable(),
  at: z.string(),
  version: z.number().int().min(1),
  reason: z.string().nullable(),
});
export type DecisionDto = z.infer<typeof DecisionDtoSchema>;

/** `GET /api/labels/history`: the decision history of every opened set of the active org, oldest decision first. Images nobody has decided on are absent. */
export const HistoryDtoSchema = z.object({
  viewer: ViewerSchema,
  history: z.array(z.object({ imageId: z.string().min(1), decisions: z.array(DecisionDtoSchema).min(1) })),
});
export type HistoryDto = z.infer<typeof HistoryDtoSchema>;
