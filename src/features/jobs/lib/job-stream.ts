/**
 * Framework-agnostic job stream client (plan §5.1, §9.2 "SSE with polling
 * fallback").
 *
 * Opens an `EventSource` on `/api/jobs/:id/events`. EventSource already
 * reconnects by itself (sending `Last-Event-ID`), so a few transient errors
 * are tolerated; after `maxSseFailures` consecutive failures — or if the
 * browser gives up (CLOSED) or has no EventSource — it switches to JSON
 * polling of the same endpoint (`?format=json&after=<seq>`) and never
 * switches back mid-job. Events are de-duplicated by `seq`, so a replay after
 * a reconnect (or the SSE → polling handoff) never shows twice.
 *
 * All browser APIs are injected, so the transport state machine is unit
 * tested with fakes — no DOM required. `useJobStream` is the thin React shell.
 */
import type { JobDtoT, JobEventDtoT, JobEventsPageT, JobStatusT } from "@/shared/contracts/jobs";

export type StreamTransport = "idle" | "sse" | "polling";

export interface JobStreamState {
  transport: StreamTransport;
  job: JobDtoT | null;
  status: JobStatusT | "unknown";
  events: JobEventDtoT[];
  done: boolean;
  error: string | null;
}

export const IDLE_STREAM: JobStreamState = {
  transport: "idle",
  job: null,
  status: "unknown",
  events: [],
  done: false,
  error: null,
};

/** The slice of `EventSource` we use (also what the test fake implements). */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data?: string }) => void): void;
  close(): void;
}

export interface JobStreamDeps {
  /** URL for a request resuming after `after`; `json` selects the polling form. */
  url: (after: number, json: boolean) => string;
  createEventSource?: (url: string) => EventSourceLike;
  fetchFn: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  maxSseFailures?: number;
  pollMs?: number;
  maxPollBackoffMs?: number;
}

const EVENT_TYPES = ["progress", "log", "turn", "artifact", "partial"] as const;
const CLOSED = 2;

export interface JobStream {
  getSnapshot(): JobStreamState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
}

export function createJobStream(deps: JobStreamDeps): JobStream {
  const maxFailures = deps.maxSseFailures ?? 3;
  const pollMs = deps.pollMs ?? 1500;
  const maxBackoff = deps.maxPollBackoffMs ?? 10_000;

  let state: JobStreamState = IDLE_STREAM;
  const listeners = new Set<() => void>();
  let es: EventSourceLike | null = null;
  let timer: unknown = null;
  let after = 0;
  let failures = 0;
  let pollFailures = 0;
  let stopped = true;

  const set = (patch: Partial<JobStreamState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const addEvent = (e: JobEventDtoT) => {
    // De-dupe by seq: a reconnect or the SSE → polling handoff may replay events.
    if (state.events.some((x) => x.seq === e.seq)) return;
    after = Math.max(after, e.seq);
    set({ events: [...state.events, e].sort((a, b) => a.seq - b.seq) });
  };

  const setJob = (job: JobDtoT) => set({ job, status: job.status });

  const parse = <T>(raw: string | undefined): T | null => {
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  };

  const closeEs = () => {
    if (es) {
      es.onerror = null;
      es.close();
      es = null;
    }
  };

  const finish = () => {
    closeEs();
    if (timer !== null) deps.clearTimeoutFn(timer);
    timer = null;
    set({ done: true });
  };

  // ------------------------------------------------------------------ polling
  const poll = async () => {
    if (stopped) return;
    try {
      const res = await deps.fetchFn(deps.url(after, true));
      if (!res.ok) {
        // Auth/not-found will not heal by retrying.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          set({ error: `HTTP ${res.status}`, done: true });
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const page = (await res.json()) as JobEventsPageT;
      pollFailures = 0;
      for (const e of page.events) addEvent(e);
      after = Math.max(after, page.nextAfter);
      set({ job: page.job, status: page.job.status, error: null });
      if (page.done) return finish();
    } catch (err) {
      pollFailures += 1;
      set({ error: err instanceof Error ? err.message : "poll failed" });
    }
    if (stopped) return;
    const delay = Math.min(maxBackoff, pollMs * 2 ** Math.min(pollFailures, 6));
    timer = deps.setTimeoutFn(() => void poll(), pollFailures === 0 ? pollMs : delay);
  };

  const startPolling = () => {
    closeEs();
    set({ transport: "polling" });
    void poll();
  };

  // ---------------------------------------------------------------------- sse
  const openSse = () => {
    if (!deps.createEventSource) return startPolling();
    set({ transport: "sse", error: null });
    const source = deps.createEventSource(deps.url(after, false));
    es = source;

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (ev) => {
        failures = 0;
        const e = parse<JobEventDtoT>(ev.data);
        if (e) addEvent(e);
      });
    }
    source.addEventListener("status", (ev) => {
      failures = 0;
      const job = parse<JobDtoT>(ev.data);
      if (job) setJob(job);
    });
    source.addEventListener("end", () => finish());
    source.addEventListener("reconnect", (ev) => {
      // Server closed before its platform limit; resume where we left off.
      const r = parse<{ after?: number }>(ev.data);
      if (r?.after !== undefined) after = Math.max(after, r.after);
      closeEs();
      if (!stopped) openSse();
    });
    source.addEventListener("fault", (ev) => {
      const f = parse<{ code?: string }>(ev.data);
      set({ error: f?.code ?? "stream fault", done: f?.code === "not_found" });
      if (f?.code === "not_found") closeEs();
    });
    source.onerror = () => {
      failures += 1;
      // CLOSED = the browser gave up reconnecting; otherwise let it retry a few times.
      if (source.readyState === CLOSED || failures >= maxFailures) {
        if (!stopped && !state.done) startPolling();
      }
    };
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (!stopped) return;
      stopped = false;
      after = 0;
      failures = 0;
      pollFailures = 0;
      state = { ...IDLE_STREAM };
      openSse();
    },
    stop() {
      stopped = true;
      closeEs();
      if (timer !== null) deps.clearTimeoutFn(timer);
      timer = null;
    },
  };
}
