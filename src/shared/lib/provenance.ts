/**
 * One sentence, one meaning, on every surface that shows a recorded trace.
 *
 * The 38 demo traces are supervision data produced by a frontier LLM in a tool
 * loop with ground-truth guidance, then verified for format by a different model
 * family. They are not a trained model's output, and treating them as
 * performance numbers would be the most flattering lie this app could tell.
 */
export const TRAINING_TRACE_PROVENANCE =
  "Teacher-generated SFT training traces: a frontier LLM produced them in a tool loop with ground-truth guidance, and a different model family checked the format. They are supervision data, not this model's performance - performance numbers live on /evals.";

/** Short form for a badge tooltip. */
export const TRAINING_TRACE_PROVENANCE_SHORT =
  "Teacher-generated SFT training trace (frontier LLM + ground-truth guidance, cross-family verified). Supervision data, not model performance.";

/** What "passed trace verification" means, and what it does not. */
export const TRACE_VERIFICATION_EXPLANATION =
  "Trace verification checks the output format and whether the findings match the recorded ground truth, using a different model family than the one that wrote the trace. It is not a clinical validation.";
