/**
 * Process-wide bus accessor. The bus is OPTIONAL by design (plan §0 rule 4): with no `REDIS_URL`, an
 * invalid one, or a Redis that is down, everything keeps working on database polling.
 */
import { getEnv } from "@/shared/config/env";
import type { EventBus } from "./bus";

export { jobChannel, queueChannel, safePublish, openWake, MemoryBus } from "./bus";
export type { EventBus, Wake, Unsubscribe } from "./bus";

const G = globalThis as unknown as { __tfBus?: { bus: EventBus | undefined } };
const REDIS_SCHEME = /^rediss?:\/\//i;

/**
 * Build a bus from a URL. `undefined` for no URL, a URL that is not `redis://` / `rediss://`, or a client that fails to
 * start — in every case the app simply runs on database polling. Never throws; the Redis client is imported only when needed.
 */
export async function createEventBus(url: string | undefined): Promise<EventBus | undefined> {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (!REDIS_SCHEME.test(trimmed)) {
    console.warn("[realtime] REDIS_URL is set but is not a redis:// or rediss:// URL; running on database polling.");
    return undefined;
  }
  try {
    const { RedisBus } = await import("./redis-bus");
    return new RedisBus(trimmed);
  } catch (e) {
    console.warn("[realtime] could not start the Redis bus; running on database polling:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** The process-wide bus (created once). `undefined` = none configured, the default. */
export async function getEventBus(): Promise<EventBus | undefined> {
  if (G.__tfBus) return G.__tfBus.bus;
  const bus = await createEventBus(getEnv().REDIS_URL);
  G.__tfBus = { bus };
  return bus;
}

export type BusState = "absent" | "up" | "down";

/** For /status and /api/health: `absent` (not configured), `up`, or `down` (configured but unreachable — polling in effect). */
export async function getBusState(): Promise<BusState> {
  const bus = await getEventBus();
  if (!bus) return "absent";
  return (await bus.ping()) ? "up" : "down";
}

/** Test hook: install (or clear) the process-wide bus. */
export function __setEventBusForTests(bus: EventBus | undefined): void {
  G.__tfBus = { bus };
}
