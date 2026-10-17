/**
 * Browser client of /api/labels (ADR-0019). Framework-free: `fetch` is injected, nothing here touches React or storage.
 * Every outcome is a typed result, never an exception, so the sync engine decides what each one means:
 * ok | conflict (version/state, with the server's current set) | unauthorized | forbidden | notFound | invalid | unavailable.
 */
import { SetDtoSchema, type SetDto } from "./dto";

export type LabelResult<T = SetDto> =
  | { kind: "ok"; value: T }
  | { kind: "conflict"; reason: "version" | "state"; set: SetDto }
  | { kind: "unauthorized" }
  | { kind: "forbidden"; message: string }
  | { kind: "notFound" }
  | { kind: "invalid"; message: string }
  /** Network failure, 5xx, 429 or an unreadable answer; `retryAfterMs` is the server's `Retry-After` when it sent one. */
  | { kind: "unavailable"; retryAfterMs: number | null; message: string };

export type TransitionName = "submit" | "approve" | "reject" | "reopen";

export interface LabelClient {
  get(imageId: string): Promise<LabelResult>;
  open(imageId: string): Promise<LabelResult>;
  ops(imageId: string, baseVersion: number, ops: unknown[], opts?: { keepalive?: boolean }): Promise<LabelResult>;
  transition(imageId: string, input: { transition: TransitionName; baseVersion: number; reason?: string }): Promise<LabelResult>;
}

const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** `Retry-After` as delay-seconds (the form this API sends); anything else is ignored. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
}

function problemText(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as { detail?: unknown; title?: unknown };
    if (typeof b.detail === "string" && b.detail) return b.detail;
    if (typeof b.title === "string" && b.title) return b.title;
  }
  return fallback;
}

export function createLabelClient(fetchImpl: typeof fetch = (...a) => fetch(...a), base = "/api/labels"): LabelClient {
  async function call(method: "GET" | "POST", imageId: string, action: string, body?: unknown, keepalive = false): Promise<LabelResult> {
    const url = `${base}/${encodeURIComponent(imageId)}${action}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(keepalive ? { keepalive: true } : {}),
      });
    } catch (e) {
      return { kind: "unavailable", retryAfterMs: null, message: e instanceof Error ? e.message : "network error" };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (res.status === 200) {
      const dto = SetDtoSchema.safeParse(parsed);
      return dto.success ? { kind: "ok", value: dto.data } : { kind: "unavailable", retryAfterMs: null, message: "unexpected response from the server" };
    }
    if (res.status === 409) {
      const b = (parsed ?? {}) as { reason?: unknown; set?: unknown };
      const set = SetDtoSchema.safeParse(b.set);
      if (set.success && (b.reason === "version" || b.reason === "state")) return { kind: "conflict", reason: b.reason, set: set.data };
      return { kind: "unavailable", retryAfterMs: null, message: "unreadable conflict answer" };
    }
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 403) return { kind: "forbidden", message: problemText(parsed, "Not allowed") };
    if (res.status === 404) return { kind: "notFound" };
    if (res.status === 400 || res.status === 413 || res.status === 415 || res.status === 422) {
      return { kind: "invalid", message: problemText(parsed, `The server refused the request (HTTP ${res.status})`) };
    }
    return { kind: "unavailable", retryAfterMs: retryAfterMs(res), message: problemText(parsed, `Server answered HTTP ${res.status}`) };
  }

  return {
    get: (id) => call("GET", id, ""),
    open: (id) => call("POST", id, "/open", {}),
    ops: (id, baseVersion, ops, opts) => call("POST", id, "/ops", { baseVersion, ops }, opts?.keepalive),
    transition: (id, input) => call("POST", id, "/transition", input),
  };
}
