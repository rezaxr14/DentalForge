/**
 * Client transport state machine (SSE → polling fallback) with injected fakes.
 */
import { describe, expect, it } from "vitest";
import { createJobStream, type EventSourceLike } from "@/features/jobs/lib/job-stream";
import type { JobDtoT, JobEventDtoT } from "@/shared/contracts/jobs";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private handlers = new Map<string, ((ev: { data?: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data?: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    for (const h of this.handlers.get(type) ?? []) h({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  fail(readyState = 0) {
    this.readyState = readyState;
    this.onerror?.({});
  }
}

const job = (status: JobDtoT["status"]): JobDtoT => ({
  id: "j", type: "system.ping", version: 1, status, priority: 0, attempts: 1, maxAttempts: 3,
  payload: {}, result: null, error: null, artifactIds: [], claimedBy: null,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
});
const ev = (seq: number): JobEventDtoT => ({ seq, type: "progress", data: { seq }, createdAt: "2026-10-10T00:00:00.000Z" });

function harness(overrides: { noEventSource?: boolean; fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> } = {}) {
  FakeEventSource.instances = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  const fetched: string[] = [];
  const stream = createJobStream({
    url: (after, json) => `/e?after=${after}${json ? "&format=json" : ""}`,
    createEventSource: overrides.noEventSource ? undefined : (url) => new FakeEventSource(url),
    fetchFn: async (url) => {
      fetched.push(url);
      return overrides.fetchImpl ? overrides.fetchImpl(url) : { ok: true, status: 200, json: async () => ({ job: job("running"), events: [], nextAfter: 0, done: false }) };
    },
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms, id: ++id });
      return id;
    },
    clearTimeoutFn: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    maxSseFailures: 3,
    pollMs: 1000,
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { stream, timers, fetched, flush };
}

describe("createJobStream", () => {
  it("streams over SSE, de-duplicates replayed events and finishes on `end`", () => {
    const { stream } = harness();
    stream.start();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/e?after=0");
    expect(stream.getSnapshot().transport).toBe("sse");

    es.emit("status", job("running"));
    es.emit("progress", ev(1));
    es.emit("turn", { ...ev(2), type: "turn" });
    es.emit("progress", ev(2)); // replay of seq 2
    expect(stream.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2]);
    expect(stream.getSnapshot().status).toBe("running");
    expect(stream.getSnapshot().done).toBe(false);

    es.emit("status", job("succeeded"));
    es.emit("end", { status: "succeeded" });
    expect(stream.getSnapshot().done).toBe(true);
    expect(stream.getSnapshot().status).toBe("succeeded");
    expect(es.closed).toBe(true);
  });

  it("tolerates transient errors (the browser reconnects itself) and resets on success", () => {
    const { stream } = harness();
    stream.start();
    const es = FakeEventSource.instances[0]!;
    es.fail(0);
    es.fail(0);
    expect(stream.getSnapshot().transport).toBe("sse"); // 2 < maxSseFailures
    es.emit("progress", ev(1)); // a good message clears the failure streak
    es.fail(0);
    es.fail(0);
    expect(stream.getSnapshot().transport).toBe("sse");
    expect(es.closed).toBe(false);
  });

  it("falls back to polling after repeated SSE failures, resuming from the last seq", async () => {
    const pages = [
      { job: job("running"), events: [ev(2), ev(3)], nextAfter: 3, done: false },
      { job: job("succeeded"), events: [ev(4)], nextAfter: 4, done: true },
    ];
    const { stream, timers, fetched, flush } = harness({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => pages.shift() }),
    });
    stream.start();
    const es = FakeEventSource.instances[0]!;
    es.emit("progress", ev(1));
    es.fail(0);
    es.fail(0);
    es.fail(0); // third consecutive failure
    await flush();
    expect(stream.getSnapshot().transport).toBe("polling");
    expect(es.closed).toBe(true);
    expect(fetched[0]).toBe("/e?after=1&format=json"); // resumes after seq 1

    expect(timers).toHaveLength(1);
    timers[0]!.fn(); // next poll
    await flush();
    expect(stream.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(stream.getSnapshot().done).toBe(true);
    expect(stream.getSnapshot().status).toBe("succeeded");
    expect(timers).toHaveLength(0); // no more polling once done
  });

  it("falls back immediately when the browser gives up (CLOSED) or has no EventSource", async () => {
    const a = harness();
    a.stream.start();
    FakeEventSource.instances[0]!.fail(2);
    await a.flush();
    expect(a.stream.getSnapshot().transport).toBe("polling");

    const b = harness({ noEventSource: true });
    b.stream.start();
    await b.flush();
    expect(b.stream.getSnapshot().transport).toBe("polling");
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("re-opens the stream from the right place on a server `reconnect` frame", () => {
    const { stream } = harness();
    stream.start();
    const first = FakeEventSource.instances[0]!;
    first.emit("progress", ev(1));
    first.emit("progress", ev(2));
    first.emit("reconnect", { after: 2 });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe("/e?after=2");
    expect(stream.getSnapshot().transport).toBe("sse");
  });

  it("stops polling for good on 401/404 and backs off on server errors", async () => {
    let status = 500;
    const { stream, timers, flush } = harness({
      noEventSource: true,
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
    });
    stream.start();
    await flush();
    expect(stream.getSnapshot().error).toBe("HTTP 500");
    expect(timers).toHaveLength(1);
    const first = timers[0]!.ms;
    timers[0]!.fn();
    await flush();
    expect(timers.at(-1)!.ms).toBeGreaterThan(first); // exponential backoff

    status = 404;
    timers.at(-1)!.fn();
    await flush();
    expect(stream.getSnapshot().done).toBe(true);
    expect(stream.getSnapshot().error).toBe("HTTP 404");
  });

  it("a `fault: not_found` frame ends the stream; stop() cancels everything", () => {
    const { stream, timers } = harness();
    stream.start();
    const es = FakeEventSource.instances[0]!;
    es.emit("fault", { code: "not_found" });
    expect(stream.getSnapshot().done).toBe(true);
    expect(es.closed).toBe(true);

    const h = harness();
    h.stream.start();
    h.stream.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(h.timers).toHaveLength(0);
    void timers;
  });

  it("notifies subscribers on every change and supports unsubscribe", () => {
    const { stream } = harness();
    let n = 0;
    const off = stream.subscribe(() => (n += 1));
    stream.start();
    FakeEventSource.instances[0]!.emit("progress", ev(1));
    const seen = n;
    expect(seen).toBeGreaterThan(0);
    off();
    FakeEventSource.instances[0]!.emit("progress", ev(2));
    expect(n).toBe(seen);
  });
});
