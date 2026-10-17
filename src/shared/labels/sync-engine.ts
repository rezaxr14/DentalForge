/**
 * The editor's connection to the server (ADR-0020). Framework-free: the clock, `fetch` (through the client) and the editor
 * are injected, so it runs against the real handlers in unit tests and inside React unchanged.
 *
 * Model. `acked` is the boxes the server last confirmed. What still has to be sent is never a queue of commands but
 * `diffToCommands(acked, present)`, computed when a request is about to go out. That is what makes these rules simple:
 *  - one request in flight; edits made meanwhile are simply part of the next diff;
 *  - debounce with a max-wait, so continuous editing still saves;
 *  - 409 version: adopt the server's boxes, then `present = diff.reduce(apply, server)`: last writer wins per field and a box
 *    someone else deleted is not resurrected. The merged boxes go back to the editor through `onRemote`;
 *  - 409 state (the set is no longer a draft): adopt it, become read-only, tell the user the newest edits were not saved;
 *  - 503/429/network: keep the edits in memory, retry after `Retry-After` or an exponential backoff (1 s, 2 s, … 30 s);
 *  - 401: this set can no longer be saved to the server → mode "local"; the editor must persist its boxes locally. A set is
 *    server-backed or local, never both;
 *  - 422: the server refused the edit; no automatic retry (it would repeat forever), the next edit tries again.
 *
 * Contract with the editor: `getPresent()` must return the newest boxes synchronously, INCLUDING right after `onRemote`
 * (keep them in a ref and update it inside the callback). The engine calls `onRemote` only for boxes that differ from what
 * the editor already has because of the server (load, rebase, transition, state conflict), never to echo the editor's own edits.
 */
import type { Annotation, AnnotationStatus } from "@/shared/contracts/labels";
import { diffToCommands } from "@/shared/domain/editing/diff";
import { apply } from "@/shared/domain/editing/history";
import { MAX_OPS_PER_REQUEST } from "@/shared/domain/editing/persist";
import type { LabelClient, LabelResult, TransitionName } from "./client";
import type { SetDto, Viewer } from "./dto";

export type SyncMode = "connecting" | "server" | "local";
export type LocalReason = "signed-out" | "session-lost" | "server-unavailable" | "forbidden";
export type SyncStatus = "loading" | "saved" | "pending" | "saving" | "merged" | "retrying" | "error" | "readonly";
export type RemoteReason = "load" | "rebase" | "transition" | "state-conflict";

export interface SyncView {
  mode: SyncMode;
  localReason: LocalReason | null;
  status: SyncStatus;
  /** Human text for `error`, `readonly`, `retrying` and local fallbacks. */
  message: string | null;
  /** Epoch ms of the next automatic retry while `status === "retrying"`. */
  retryAt: number | null;
  version: number;
  state: AnnotationStatus;
  viewer: Viewer | null;
  assigneeId: string | null;
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SyncOptions {
  imageId: string;
  client: LabelClient;
  getPresent: () => readonly Annotation[];
  onRemote: (annotations: Annotation[], why: RemoteReason) => void;
  onView: (view: SyncView) => void;
  scheduler?: Scheduler;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
}

export interface SyncEngine {
  start(): Promise<void>;
  /** The editor's boxes changed. */
  notifyChange(): void;
  /** Send everything pending now and resolve when nothing is in flight. */
  flushNow(): Promise<void>;
  transition(t: TransitionName, reason?: string): Promise<LabelResult>;
  /** True while an edit exists that the server has not confirmed (for a "leave page?" prompt). */
  hasUnsaved(): boolean;
  /** Fire-and-forget flush for `pagehide`: uses `keepalive` so the browser may finish it after the page is gone. */
  flushOnExit(): void;
  view(): SyncView;
  stop(): void;
}

const MAX_ROUNDS = 20;
const MAX_CONSECUTIVE_CONFLICTS = 5;
const BACKOFF_CAP_MS = 30_000;
export const backoffMs = (attempt: number): number => Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (attempt - 1));

export function createSyncEngine(o: SyncOptions): SyncEngine {
  const scheduler: Scheduler = o.scheduler ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const now = o.now ?? Date.now;
  const debounceMs = o.debounceMs ?? 800;
  const maxWaitMs = o.maxWaitMs ?? 3000;

  let acked: Annotation[] = [];
  let version = 0;
  let state: AnnotationStatus = "draft";
  let viewer: Viewer | null = null;
  let assigneeId: string | null = null;
  let stopped = false;
  let merged = false;
  let attempts = 0;
  let inFlight: Promise<void> | null = null;
  let debounceTimer: unknown = null;
  let maxTimer: unknown = null;
  let retryTimer: unknown = null;
  let v: SyncView = { mode: "connecting", localReason: null, status: "loading", message: null, retryAt: null, version: 0, state: "draft", viewer: null, assigneeId: null };

  function emit(patch: Partial<SyncView>): void {
    v = { ...v, ...patch, version, state, viewer, assigneeId };
    o.onView(v);
  }
  function adopt(d: SetDto): void {
    acked = d.annotations;
    version = d.version;
    state = d.state;
    viewer = d.viewer;
    assigneeId = d.assigneeId;
  }
  const clearTimers = (): void => {
    if (debounceTimer !== null) scheduler.clear(debounceTimer);
    if (maxTimer !== null) scheduler.clear(maxTimer);
    debounceTimer = maxTimer = null;
  };
  const serverBacked = (): boolean => v.mode === "server" && viewer !== null;
  const pendingOps = (present: readonly Annotation[] = o.getPresent()) =>
    diffToCommands(acked, present, viewer ? { authorId: viewer.userId } : {});
  const settledStatus = (): SyncStatus => (state === "draft" ? (merged ? "merged" : "saved") : "readonly");

  function goLocal(reason: LocalReason, message: string | null): void {
    clearTimers();
    if (retryTimer !== null) scheduler.clear(retryTimer);
    retryTimer = null;
    emit({ mode: "local", localReason: reason, status: "saved", message, retryAt: null });
  }

  async function start(): Promise<void> {
    emit({ mode: "connecting", status: "loading" });
    let r = await o.client.get(o.imageId);
    if (r.kind === "notFound") r = await o.client.open(o.imageId);
    if (stopped) return;
    switch (r.kind) {
      case "ok":
        adopt(r.value);
        o.onRemote(r.value.annotations, "load");
        emit({ mode: "server", localReason: null, status: settledStatus(), message: null, retryAt: null });
        return;
      case "unauthorized":
        return goLocal("signed-out", null);
      case "forbidden":
        return goLocal("forbidden", r.message);
      case "unavailable":
        return goLocal("server-unavailable", r.message);
      default:
        return goLocal("server-unavailable", "message" in r ? r.message : "The server could not open this image");
    }
  }

  function schedule(): void {
    if (debounceTimer !== null) scheduler.clear(debounceTimer);
    debounceTimer = scheduler.set(() => void flushNow(), debounceMs);
    if (maxTimer === null) maxTimer = scheduler.set(() => void flushNow(), maxWaitMs);
  }

  function notifyChange(): void {
    if (stopped || !serverBacked() || state !== "draft" || v.status === "readonly") return;
    merged = false;
    // While waiting for a retry the retry itself will send the newest boxes; do not hammer a struggling server.
    if (retryTimer !== null) return;
    if (v.status !== "saving") emit({ status: "pending", message: null });
    schedule();
  }

  async function run(keepalive = false): Promise<void> {
    let conflicts = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (stopped || !serverBacked() || state !== "draft") return;
      const pending = pendingOps();
      if (pending.length === 0) {
        attempts = 0;
        emit({ status: settledStatus(), message: null, retryAt: null });
        return;
      }
      emit({ status: "saving", message: null, retryAt: null });
      const r = await o.client.ops(o.imageId, version, pending.slice(0, MAX_OPS_PER_REQUEST), { keepalive });
      if (stopped) return;
      switch (r.kind) {
        case "ok":
          adopt(r.value);
          attempts = 0;
          conflicts = 0;
          break;
        case "conflict": {
          // A set that is no longer a draft cannot take my edits. (The server compares versions before state, so a stale writer
          // on a set that has since been submitted arrives as a version conflict, not a state one.)
          if (r.set.state !== "draft") {
            adopt(r.set);
            o.onRemote(r.set.annotations, "state-conflict");
            emit({ status: "readonly", message: "This set is no longer a draft, so your latest edits were not saved." });
            return;
          }
          // Everything I have not got confirmed, measured against the boxes it was built on, replayed on the server's newer ones.
          const mine = pendingOps();
          adopt(r.set);
          o.onRemote(mine.reduce(apply, r.set.annotations.slice()), "rebase");
          merged = true;
          if (++conflicts > MAX_CONSECUTIVE_CONFLICTS) {
            emit({ status: "error", message: "Several people are editing this image at once; your edits could not be merged yet. Edit again to retry." });
            return;
          }
          break;
        }
        case "unauthorized":
          return goLocal("session-lost", "You were signed out. Your edits are kept in this browser.");
        case "forbidden":
          emit({ status: "readonly", message: r.message });
          return;
        case "unavailable": {
          attempts++;
          const delay = r.retryAfterMs ?? backoffMs(attempts);
          emit({ status: "retrying", message: r.message, retryAt: now() + delay });
          retryTimer = scheduler.set(() => {
            retryTimer = null;
            void flushNow();
          }, delay);
          return;
        }
        default:
          emit({ status: "error", message: "message" in r ? r.message : "The server could not save this edit" });
          return;
      }
    }
    emit({ status: "error", message: "The edits did not converge with the server; edit again to retry." });
  }

  function flushNow(): Promise<void> {
    clearTimers();
    if (retryTimer !== null) {
      scheduler.clear(retryTimer);
      retryTimer = null;
    }
    if (inFlight) {
      // An edit arrived while a request is out: the running loop re-diffs after each answer, so wait for it and run once more.
      return inFlight.then(() => (inFlight ? inFlight : flushNow()));
    }
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function transition(t: TransitionName, reason?: string): Promise<LabelResult> {
    if (!serverBacked()) return { kind: "invalid", message: "This image is not saved to the server" };
    await flushNow();
    if (stopped) return { kind: "unavailable", retryAfterMs: null, message: "stopped" };
    if (pendingOps().length > 0) return { kind: "invalid", message: "Your latest edits are not saved to the server yet, so the set cannot change state." };
    const r = await o.client.transition(o.imageId, { transition: t, baseVersion: version, ...(reason !== undefined ? { reason } : {}) });
    if (stopped) return r;
    if (r.kind === "ok" || r.kind === "conflict") {
      const dto = r.kind === "ok" ? r.value : r.set;
      adopt(dto);
      o.onRemote(dto.annotations, "transition");
      merged = false;
      emit({ status: settledStatus(), message: null, retryAt: null });
    } else if (r.kind === "unauthorized") {
      goLocal("session-lost", "You were signed out. Your edits are kept in this browser.");
    }
    return r;
  }

  return {
    start,
    notifyChange,
    flushNow,
    transition,
    hasUnsaved: () => serverBacked() && state === "draft" && pendingOps().length > 0,
    flushOnExit: () => {
      if (stopped || !serverBacked() || state !== "draft" || inFlight || pendingOps().length === 0) return;
      clearTimers();
      inFlight = run(true).finally(() => {
        inFlight = null;
      });
    },
    view: () => v,
    stop: () => {
      stopped = true;
      clearTimers();
      if (retryTimer !== null) scheduler.clear(retryTimer);
      retryTimer = null;
    },
  };
}
