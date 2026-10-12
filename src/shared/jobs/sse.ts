/**
 * Job event streaming (plan §5.1).
 *
 * Source of truth is the append-only `job_events` table. The stream is a bounded
 * DB read loop: it forwards new events, emits a `status` frame whenever the job's
 * status/attempt changes, and closes with `end` once the job is terminal and drained.
 *
 * Between reads it waits. Without a bus it sleeps `pollMs`. With the optional wake-up bus
 * (ADR-0015) it waits for a hint ("this job changed") and only polls every `safetyPollMs` as
 * a safety net, so events appear immediately and an idle stream costs almost no database
 * reads. A lost hint costs latency only: the next read always returns exactly what is stored.
 *
 * Serverless-safe: it closes itself after `maxMs` with a `reconnect` frame so
 * `EventSource` resumes (via `Last-Event-ID`) before the platform kills the
 * function. The same data is available as plain JSON (`jobEventsPage`) for
 * the polling fallback.
 */
import { TERMINAL_STATUSES, type JobEventsPageT } from "@/shared/contracts/jobs";
import type { ScopedRepos } from "@/shared/db/repos";
import { SAFETY_POLL_MS, jobChannel, openWake, type EventBus, type Wake } from "@/shared/realtime/bus";
import { toEventDto, toJobDto } from "./mappers";

export interface SseOptions {
  afterSeq: number;
  pollMs: number;
  maxMs: number;
  keepaliveMs: number;
  pageSize: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
  /** Optional wake-up bus. Absent (the default) = pure polling. */
  bus?: EventBus;
  /** While the bus is healthy, how rarely to poll the database as a safety net. Default {@link SAFETY_POLL_MS}. */
  safetyPollMs?: number;
}

export const DEFAULT_SSE: Omit<SseOptions, "afterSeq" | "signal"> = {
  pollMs: 800,
  maxMs: 45_000,
  keepaliveMs: 15_000,
  pageSize: 200,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

export function sseFrame(parts: { id?: number; event?: string; data?: unknown; comment?: string; retry?: number }): string {
  let out = "";
  if (parts.comment !== undefined) out += `: ${parts.comment}\n`;
  if (parts.retry !== undefined) out += `retry: ${parts.retry}\n`;
  if (parts.id !== undefined) out += `id: ${parts.id}\n`;
  if (parts.event) out += `event: ${parts.event}\n`;
  if (parts.data !== undefined) out += `data: ${JSON.stringify(parts.data)}\n`;
  return out + "\n";
}

export function jobEventStream(repos: ScopedRepos, jobId: string, opts: SseOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cancelled = false;
  let wake: Wake | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      const started = opts.now();
      let after = opts.afterSeq;
      let lastStatusKey = "";
      let lastSent = started;
      try {
        send(sseFrame({ retry: 2000 }));
        // Subscribe BEFORE the first read: a change after this point yields a hint, a change before it is read below.
        wake = await openWake(opts.bus, jobChannel(jobId));
        if (cancelled) await wake.close();
        opts.signal?.addEventListener("abort", () => wake?.poke(), { once: true });
        while (!cancelled && !opts.signal?.aborted) {
          await repos.reapJobs(); // a dead worker's job flips back to `queued` while we watch
          const job = await repos.getJob(jobId);
          if (!job) {
            send(sseFrame({ event: "fault", data: { code: "not_found" } }));
            break;
          }
          const events = await repos.listJobEvents(jobId, after, opts.pageSize);
          for (const e of events) {
            send(sseFrame({ id: e.seq, event: e.type, data: toEventDto(e) }));
            after = e.seq;
            lastSent = opts.now();
          }
          const key = `${job.status}:${job.attempts}`;
          if (key !== lastStatusKey) {
            lastStatusKey = key;
            send(sseFrame({ event: "status", data: toJobDto(job) }));
            lastSent = opts.now();
          }
          const drained = events.length < opts.pageSize;
          if (TERMINAL_STATUSES.has(job.status) && drained) {
            send(sseFrame({ event: "end", data: { status: job.status } }));
            break;
          }
          if (opts.now() - started >= opts.maxMs) {
            send(sseFrame({ event: "reconnect", data: { after } }));
            break;
          }
          if (opts.now() - lastSent >= opts.keepaliveMs) {
            send(sseFrame({ comment: "keepalive" }));
            lastSent = opts.now();
          }
          if (!drained) continue;
          await wake.wait(opts.pollMs, opts.sleep, opts.safetyPollMs ?? SAFETY_POLL_MS);
        }
      } catch {
        try {
          send(sseFrame({ event: "fault", data: { code: "internal" } }));
        } catch {
          /* controller already closed */
        }
      } finally {
        await wake?.close(); // release the subscription however the stream ended
        try {
          controller.close();
        } catch {
          /* already closed by cancel */
        }
      }
    },
    cancel() {
      cancelled = true;
      void wake?.close(); // ends a pending wait now instead of after the safety interval
    },
  });
}

/** Polling fallback: same data as the stream, one page, no waiting. */
export async function jobEventsPage(
  repos: ScopedRepos,
  jobId: string,
  afterSeq: number,
  pageSize = 200,
): Promise<JobEventsPageT | null> {
  await repos.reapJobs();
  const job = await repos.getJob(jobId);
  if (!job) return null;
  const events = await repos.listJobEvents(jobId, afterSeq, pageSize);
  const nextAfter = events.length > 0 ? events[events.length - 1]!.seq : afterSeq;
  return {
    job: toJobDto(job),
    events: events.map(toEventDto),
    nextAfter,
    done: TERMINAL_STATUSES.has(job.status) && events.length < pageSize,
  };
}
