/**
 * Mock worker main loop. Speaks the REAL contract over HTTP, so it is both the
 * dev stand-in for a GPU worker and the e2e fixture for the whole queue.
 *
 * Robustness (what a Colab/Kaggle worker must also do):
 *   - heartbeat on a timer, independent of job work (renews leases);
 *   - treat 409 on any job write as "lease lost — drop the job";
 *   - treat 503 as "server/DB down — back off and keep polling", never as a bad token;
 *   - treat 401 as fatal (token revoked), and cancelJobIds as an abort signal.
 */
import { ContractError, WorkerClient, type ClaimedJob } from "./client";
import { HANDLERS, NonRetryable } from "./handlers";

export interface JobContext {
  job: ClaimedJob;
  workerName: string;
  stepDelayMs: number;
  emit(type: "progress" | "log" | "turn" | "artifact" | "partial", data: unknown): Promise<void>;
  upload(name: string, mime: string, bytes: Buffer): Promise<string>;
  sleep(ms: number): Promise<void>;
  aborted(): boolean;
}

export interface WorkerOptions {
  baseUrl: string;
  token: string;
  name?: string;
  stepDelayMs?: number;
  /** Stop after this many jobs (e2e). */
  maxJobs?: number;
  claimWaitMs?: number;
  heartbeatMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runWorker(opts: WorkerOptions): Promise<{ processed: number }> {
  const log = opts.log ?? ((m: string) => console.log(`[mock-worker] ${m}`));
  const name = opts.name ?? "mock-worker";
  const client = new WorkerClient(opts.baseUrl, opts.token);
  const accepts = Object.keys(HANDLERS);
  const cancelled = new Set<string>();
  let busy = false;
  let processed = 0;

  const reg = await withRetry(() => client.register(name, "local-gpu", accepts.map((job) => ({ job, versions: [1] }))), log, opts.signal);
  log(`registered as ${client.workerId} (lease ${reg.leaseSeconds}s)`);

  const beat = setInterval(() => {
    client
      .heartbeat(busy ? "busy" : "idle")
      .then((r) => r.cancelJobIds.forEach((id) => cancelled.add(id)))
      .catch((e) => log(`heartbeat failed: ${(e as Error).message}`));
  }, opts.heartbeatMs ?? 10_000);

  try {
    while (!opts.signal?.aborted && (opts.maxJobs === undefined || processed < opts.maxJobs)) {
      let jobs: ClaimedJob[];
      try {
        jobs = await client.claim(accepts, opts.claimWaitMs ?? 10_000);
      } catch (e) {
        if (e instanceof ContractError && e.status === 401) throw e; // revoked token: do not hammer
        const wait = e instanceof ContractError && e.retryAfterSec ? e.retryAfterSec * 1000 : 3000;
        log(`claim failed (${(e as Error).message}); retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      for (const job of jobs) {
        busy = true;
        await runJob(client, job, name, opts.stepDelayMs ?? 300, cancelled, log);
        busy = false;
        processed += 1;
      }
    }
  } finally {
    clearInterval(beat);
  }
  return { processed };
}

async function runJob(client: WorkerClient, job: ClaimedJob, workerName: string, stepDelayMs: number, cancelled: Set<string>, log: (m: string) => void) {
  const handler = HANDLERS[job.type];
  if (!handler) {
    await client.fail(job.id, { code: "unsupported_job", message: `mock does not handle ${job.type}`, retryable: false }).catch(() => {});
    return;
  }
  let seq = 0;
  const artifactIds: string[] = [];
  const ctx: JobContext = {
    job,
    workerName,
    stepDelayMs,
    aborted: () => cancelled.has(job.id),
    sleep,
    async emit(type, data) {
      if (cancelled.has(job.id)) throw new ContractError(409, "job_cancelled", "cancelled");
      await client.postEvents(job.id, [{ seq: ++seq, type, data }]);
    },
    async upload(name, mime, bytes) {
      const id = await client.uploadArtifact(job.id, name, mime, bytes);
      artifactIds.push(id);
      return id;
    },
  };
  log(`job ${job.id.slice(0, 8)} ${job.type} (attempt ${job.attempt})`);
  try {
    const result = await handler(ctx);
    await client.complete(job.id, result, artifactIds);
    log(`job ${job.id.slice(0, 8)} succeeded`);
  } catch (e) {
    if (e instanceof ContractError && e.lostJob) {
      log(`job ${job.id.slice(0, 8)} dropped: ${e.code}`); // lease lost / cancelled: nothing more to say
      return;
    }
    const retryable = !(e instanceof NonRetryable) && !(e instanceof ContractError && e.status < 500 && e.status !== 429);
    log(`job ${job.id.slice(0, 8)} failed: ${(e as Error).message}`);
    await client
      .fail(job.id, { code: e instanceof NonRetryable ? "bad_input" : "handler_error", message: (e as Error).message.slice(0, 500), retryable })
      .catch((fe) => log(`fail() also failed: ${(fe as Error).message}`));
  }
}

async function withRetry<T>(fn: () => Promise<T>, log: (m: string) => void, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ContractError && (e.status === 401 || e.status === 426)) throw e;
      if (signal?.aborted || attempt >= 20) throw e;
      const wait = Math.min(15_000, 1000 * 2 ** attempt);
      log(`register failed (${(e as Error).message}); retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}
