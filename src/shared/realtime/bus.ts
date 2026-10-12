/**
 * Realtime wake-up bus (plan §5.1, ADR-0014).
 *
 * The bus carries NO data. A message only means "something about this job/queue changed — look at
 * the database now". Postgres stays the single source of truth, so:
 *   - a lost, duplicated or late message can never lose or duplicate an event (the next DB read
 *     returns exactly what is stored, in order, resumable via `Last-Event-ID`);
 *   - a slow or dead bus only costs latency: every waiter keeps a polling safety net.
 *
 * Everything here is transport-agnostic. `redis-bus.ts` is the production transport;
 * `MemoryBus` is an in-process implementation used by tests (and fine for a single-process server).
 */

export type Unsubscribe = () => Promise<void> | void;

export interface EventBus {
  readonly kind: "memory" | "redis";
  /** Best-effort. May reject or hang; production callers use `safePublish`. */
  publish(channel: string): Promise<void>;
  /** Resolves once the subscription is ACTIVE (a publish after that point is delivered). Rejects if it cannot be established. */
  subscribe(channel: string, onHint: () => void): Promise<Unsubscribe>;
  /** Is the transport currently usable? Used to fall back to fast polling during an outage. */
  healthy(): boolean;
  /** Connectivity probe for /status and /api/health. Never rejects. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const jobChannel = (jobId: string) => `tf:job:${jobId}`;
export const queueChannel = (orgId: string) => `tf:queue:${orgId}`;

/** Upper bound a request may be delayed by a slow bus. */
export const PUBLISH_TIMEOUT_MS = 300;
export const SUBSCRIBE_TIMEOUT_MS = 500;
/** While the bus is healthy, waiters poll the database this rarely (it is only a safety net for lost hints). */
export const SAFETY_POLL_MS = 5000;

const timeout = (ms: number) =>
  new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    (t as { unref?: () => void }).unref?.();
  });

/**
 * Publish a hint without ever failing or stalling the request that caused it: errors are swallowed,
 * and a hung bus delays the caller by at most `timeoutMs`. A missed hint costs latency only.
 */
export async function safePublish(bus: EventBus | undefined, channel: string, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<void> {
  if (!bus) return;
  try {
    const p = bus.publish(channel);
    p.catch(() => undefined); // if we stop waiting, a late rejection must not become unhandled
    await Promise.race([p, timeout(timeoutMs)]);
  } catch {
    /* hint lost: waiters fall back to their polling safety net */
  }
}

export interface Wake {
  /** True while hints can actually arrive: subscribed AND the transport reports healthy. */
  readonly live: boolean;
  /**
   * Wait until a hint arrives or the poll interval elapses, whichever is first. With a live bus the interval is
   * lengthened to `safetyMs` (the database is then only polled as a safety net); otherwise it is `pollMs`.
   * A hint that arrived while the caller was busy (e.g. reading the database) makes this return immediately.
   */
  wait(pollMs: number, sleep: (ms: number) => Promise<void>, safetyMs?: number): Promise<void>;
  /** Make a pending or future `wait` return immediately (cancellation). */
  poke(): void;
  close(): Promise<void>;
}

/**
 * Subscribe BEFORE the first database read: a change that lands between the subscription and the read
 * produces a hint (so the next `wait` returns at once) and a change before it is seen by the read itself.
 * Never throws: with no bus, or if subscribing fails, the returned wake is simply timer-only.
 */
export async function openWake(bus: EventBus | undefined, channel: string, subscribeTimeoutMs = SUBSCRIBE_TIMEOUT_MS): Promise<Wake> {
  let dirty = false;
  let pending: (() => void) | null = null;
  let closed = false;
  const poke = () => {
    dirty = true;
    pending?.();
  };

  let unsubscribe: Unsubscribe | null = null;
  if (bus) {
    const sub = bus.subscribe(channel, poke);
    sub.catch(() => undefined);
    try {
      unsubscribe = await Promise.race([sub, timeout(subscribeTimeoutMs)]);
    } catch {
      // Too slow or refused. If it completes later, release it right away instead of leaking a subscription.
      void sub.then((u) => u(), () => undefined);
    }
  }

  const wake: Wake = {
    get live() {
      return unsubscribe !== null && !closed && (bus?.healthy() ?? false);
    },
    async wait(pollMs, sleep, safetyMs = SAFETY_POLL_MS) {
      if (closed) return;
      if (dirty) {
        dirty = false;
        return;
      }
      const ms = wake.live ? Math.max(pollMs, safetyMs) : pollMs;
      await Promise.race([
        sleep(ms),
        new Promise<void>((resolve) => {
          pending = resolve;
        }),
      ]);
      pending = null;
      dirty = false;
    },
    poke,
    async close() {
      if (closed) return;
      closed = true;
      pending?.();
      const u = unsubscribe;
      unsubscribe = null;
      try {
        await u?.();
      } catch {
        /* connection already gone */
      }
    },
  };
  return wake;
}

/** In-process bus: instant, deterministic, no network. Hints only reach waiters in the SAME process. */
export class MemoryBus implements EventBus {
  readonly kind = "memory" as const;
  private readonly channels = new Map<string, Set<() => void>>();
  private closed = false;

  async publish(channel: string): Promise<void> {
    if (this.closed) throw new Error("bus closed");
    for (const fn of [...(this.channels.get(channel) ?? [])]) fn();
  }

  async subscribe(channel: string, onHint: () => void): Promise<Unsubscribe> {
    if (this.closed) throw new Error("bus closed");
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(onHint);
    return () => {
      set.delete(onHint);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  healthy(): boolean {
    return !this.closed;
  }
  async ping(): Promise<boolean> {
    return !this.closed;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.channels.clear();
  }
  /** Test hook: how many waiters are subscribed to `channel`. */
  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
