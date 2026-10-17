/**
 * The set the label API returns (ADR-0019, ADR-0020), as a schema so the browser client can check what it received instead
 * of trusting a cast. The server's handlers build the same shape; a handler test parses their real output with `.strict()`
 * so an added or renamed field cannot drift away from this file unnoticed.
 */
import { z } from "zod";
import { Annotation, AnnotationStatus } from "@/shared/contracts/labels";
import { Role } from "@/shared/domain/auth";

export const SetDtoSchema = z.object({
  /** The caller's own id and role in the active org (ADR-0020). */
  viewer: z.object({ userId: z.string().min(1), role: Role }),
  version: z.number().int().min(1),
  state: AnnotationStatus,
  assigneeId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  image: z.object({ width: z.number().positive(), height: z.number().positive() }),
  annotations: z.array(Annotation),
});
export type SetDto = z.infer<typeof SetDtoSchema>;
export type Viewer = SetDto["viewer"];
