/**
 * `pnpm mock-worker` — runs the mock worker against a TraceForge deployment.
 *   TRACEFORGE_URL    default http://localhost:3000
 *   TRACEFORGE_TOKEN  required (mint one with `pnpm worker:token --org <slug>`)
 *   MOCK_WORKER_NAME  default "mock-worker"
 *   MOCK_STEP_DELAY_MS  default 300 (pacing of streamed events)
 *   MOCK_MAX_JOBS     optional: exit after N jobs (used by the e2e smoke)
 *   MOCK_CLAIM_WAIT_MS  long-poll length, default 10000 (shorter = faster shutdown)
 */
import { runWorker } from "./worker";

const token = process.env.TRACEFORGE_TOKEN;
if (!token) {
  console.error("TRACEFORGE_TOKEN is required (pnpm worker:token --org <slug>).");
  process.exit(2);
}
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());

runWorker({
  baseUrl: (process.env.TRACEFORGE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  token,
  name: process.env.MOCK_WORKER_NAME,
  stepDelayMs: process.env.MOCK_STEP_DELAY_MS ? Number(process.env.MOCK_STEP_DELAY_MS) : undefined,
  maxJobs: process.env.MOCK_MAX_JOBS ? Number(process.env.MOCK_MAX_JOBS) : undefined,
  claimWaitMs: process.env.MOCK_CLAIM_WAIT_MS ? Number(process.env.MOCK_CLAIM_WAIT_MS) : undefined,
  signal: ac.signal,
})
  .then((r) => {
    console.log(`[mock-worker] done, processed ${r.processed} job(s)`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[mock-worker] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
