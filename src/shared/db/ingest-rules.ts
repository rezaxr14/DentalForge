/**
 * Pure rules shared by the memory and Postgres stores for model registration
 * and training ingestion, so both backends are provably identical (they run
 * the same contract suite) instead of "similar".
 */

export type TrainingRunStatus = "queued" | "running" | "succeeded" | "failed";

const RANK: Record<TrainingRunStatus, number> = { queued: 0, running: 1, succeeded: 2, failed: 2 };

/**
 * A run's status only moves forward; a finished run (succeeded/failed) is final.
 * `requested` omitted = keep. A retried batch from an old session can therefore
 * never reopen a finished run. Terminal states share a rank, and the STRICT `>`
 * is what makes them final (succeeded never becomes failed or vice versa).
 */
export function mergeRunStatus(current: TrainingRunStatus, requested: TrainingRunStatus | undefined): TrainingRunStatus {
  if (requested === undefined) return current;
  return RANK[requested] > RANK[current] ? requested : current;
}

/**
 * Value as Postgres `real` (float4) returns it through node-pg: the SHORTEST
 * decimal that round-trips to the same 32-bit float. The memory store applies
 * this so reads agree with the database.
 */
export function toFloat4(v: number): number {
  const f = Math.fround(v);
  if (!Number.isFinite(f) || f === 0) return f;
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(f.toPrecision(p));
    if (Math.fround(candidate) === f) return candidate;
  }
  return f;
}
