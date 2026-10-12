/**
 * Redis pub/sub transport for the wake-up bus (ADR-0014).
 *
 * Plain Redis protocol over TCP/TLS (`REDIS_URL`; Upstash exposes a `rediss://` endpoint too), via the
 * core `@redis/client` only. Two connections per process: one publishes, one holds ALL subscriptions
 * (multiplexed, one `SUBSCRIBE` per channel regardless of how many SSE streams watch it).
 *
 * Failure model: operations fail FAST when disconnected (`disableOfflineQueue`) instead of queueing,
 * reconnection is automatic with capped backoff, and the client restores its subscriptions after a
 * reconnect. Hints sent while disconnected are simply lost — which the database safety poll covers.
 */
import { createClient, type RedisClientType } from "@redis/client";
import type { EventBus, Unsubscribe } from "./bus";

const READY_WAIT_MS = 300;

export class RedisBus implements EventBus {
  readonly kind = "redis" as const;
  private readonly pub: RedisClientType;
  private readonly sub: RedisClientType;
  private readonly connecting = new Map<RedisClientType, Promise<void>>();
  /** channel → hint callbacks of every local waiter */
  private readonly listeners = new Map<string, Set<() => void>>();
  /** channel → in-flight/complete SUBSCRIBE, so concurrent first subscribers share one */
  private readonly subscribed = new Map<string, Promise<void>>();
  private closed = false;

  constructor(url: string) {
    const options = {
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2000,
        // 250 ms, 500 ms, 1 s … capped at 15 s; never gives up (a restarted Redis is picked up again)
        reconnectStrategy: (retries: number) => Math.min(250 * 2 ** retries, 15_000),
      },
    };
    this.pub = createClient(options) as RedisClientType;
    this.sub = createClient(options) as RedisClientType;
    // An 'error' event with no listener would crash the process; connection trouble is expected and handled.
    this.pub.on("error", () => undefined);
    this.sub.on("error", () => undefined);
  }

  private async ready(client: RedisClientType, waitMs: number): Promise<boolean> {
    if (this.closed) return false;
    if (client.isReady) return true;
    let attempt = this.connecting.get(client);
    if (!attempt) {
      // `connect()` stays pending while the client retries, so it is started once and merely awaited with a bound.
      attempt = client.connect().then(
        () => undefined,
        () => undefined,
      );
      this.connecting.set(client, attempt);
    }
    await Promise.race([attempt, new Promise<void>((r) => setTimeout(r, waitMs).unref?.())]);
    return client.isReady;
  }

  async publish(channel: string): Promise<void> {
    if (!(await this.ready(this.pub, READY_WAIT_MS))) throw new Error("redis not ready");
    await this.pub.publish(channel, "1");
  }

  async subscribe(channel: string, onHint: () => void): Promise<Unsubscribe> {
    if (!(await this.ready(this.sub, READY_WAIT_MS))) throw new Error("redis not ready");
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(onHint);

    let active = this.subscribed.get(channel);
    if (!active) {
      active = this.sub.subscribe(channel, () => {
        for (const fn of [...(this.listeners.get(channel) ?? [])]) fn();
      });
      this.subscribed.set(channel, active);
    }
    try {
      await active;
    } catch (e) {
      set.delete(onHint);
      if (set.size === 0) {
        this.listeners.delete(channel);
        this.subscribed.delete(channel);
      }
      throw e;
    }

    return async () => {
      const current = this.listeners.get(channel);
      current?.delete(onHint);
      if (current && current.size === 0) {
        this.listeners.delete(channel);
        this.subscribed.delete(channel);
        try {
          await this.sub.unsubscribe(channel);
        } catch {
          /* connection gone: the server forgot the subscription with it */
        }
      }
    };
  }

  healthy(): boolean {
    return !this.closed && this.sub.isReady;
  }

  async ping(): Promise<boolean> {
    try {
      if (!(await this.ready(this.pub, READY_WAIT_MS))) return false;
      await this.pub.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.subscribed.clear();
    for (const c of [this.pub, this.sub]) {
      try {
        c.destroy();
      } catch {
        /* never connected */
      }
    }
  }
}
