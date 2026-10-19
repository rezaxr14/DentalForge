/**
 * A `fetch` that answers /api/labels/* by calling the REAL handlers on a real store (no HTTP, no Next): so the sync engine
 * is tested against the actual validation, versioning, state machine and authorisation, not against a mock of them.
 */
import type { OrgStore } from "@/shared/db/repos";
import * as h from "@/shared/labels/handlers";
import type { Actor } from "@/shared/jobs/user-handlers";

export type Intercept = (call: { method: string; action: string }) => Response | "throw" | Promise<Response | "throw" | null> | null;

export interface LabelWorld {
  store: OrgStore;
  /** Who is signed in right now; return null to simulate an expired session. */
  actor: () => Actor | null;
  /** Called before the handler; return a Response to answer instead, "throw" for a network failure, null to pass through. */
  intercept?: Intercept;
  /** Every request that reached the server side of the shim, in order. */
  log: { method: string; action: string; body: unknown; keepalive: boolean }[];
  inFlight: { now: number; max: number; done: number };
  /** A test that holds a request open on purpose sets this so "quiet" does not wait for it. */
  holding?: boolean;
}

export function newWorld(store: OrgStore, actor: () => Actor | null): LabelWorld {
  return { store, actor, log: [], inFlight: { now: 0, max: 0, done: 0 } };
}

export function labelFetch(world: LabelWorld): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const isStatus = parts[2] === "status" && parts.length === 3;
    const isList = parts.length === 2;
    const [, , imageId = "", action = isStatus ? "status" : isList ? "list" : "get"] = parts;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    world.log.push({ method, action, body, keepalive: init?.keepalive === true });
    world.inFlight.now++;
    world.inFlight.max = Math.max(world.inFlight.max, world.inFlight.now);
    try {
      const pre = world.intercept ? await world.intercept({ method, action }) : null;
      if (pre === "throw") throw new TypeError("Failed to fetch");
      if (pre) return pre;
      const deps: h.LabelDeps = { store: world.store, actor: world.actor() };
      const req = new Request(url, init);
      if (action === "status") return h.labelStatus(deps);
      if (action === "list") return await h.listSets(deps);
      if (action === "get") return await h.getSet(deps, imageId);
      if (action === "open") return await h.openSet(deps, imageId);
      if (action === "ops") return await h.postOps(req, deps, imageId);
      if (action === "transition") return await h.postTransition(req, deps, imageId);
      return new Response("not found", { status: 404 });
    } finally {
      world.inFlight.now--;
      world.inFlight.done++;
    }
  }) as typeof fetch;
}

/** A clock and timer queue the test advances by hand. */
export function manualScheduler(probe: () => number = () => 0, busy: () => boolean = () => false) {
  let t = 1_000_000;
  let id = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    set: (fn: () => void, ms: number) => {
      q.set(++id, { at: t + ms, fn });
      return id;
    },
    clear: (hnd: unknown) => void q.delete(hnd as number),
    pending: () => q.size,
    /** Move time forward, firing due timers in order (each may schedule more) and letting promises settle between them. */
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (;;) {
        await quiet(probe, busy);
        const next = [...q.entries()].filter(([, e]) => e.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = target;
      await quiet(probe, busy);
    },
  };
}

export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Wait (in real time) until the server side has been quiet: `probe()` (requests seen + requests finished) must not change for
 * several consecutive short waits AND `busy()` (a request is in flight) must be false. The Postgres store answers in milliseconds, microtask turns are not enough.
 */
export async function quiet(probe: () => number, busy: () => boolean = () => false, stable = 3, stepMs = 4): Promise<void> {
  await settle(5);
  let last = -1;
  let same = 0;
  for (let i = 0; i < 2000 && same < stable; i++) {
    await new Promise((r) => setTimeout(r, stepMs));
    const cur = probe();
    same = cur === last && !busy() ? same + 1 : 0;
    last = cur;
  }
}
