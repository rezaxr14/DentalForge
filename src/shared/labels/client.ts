/**
 * Browser client of /api/labels (ADR-0019). Framework-free: `fetch` is injected, nothing here touches React or storage.
 * Every outcome is a typed result, never an exception, so the sync engine decides what each one means:
 * ok | conflict (version/state, with the server's current set) | unauthorized | forbidden | notFound | invalid | unavailable.
 */
import { HistoryDtoSchema, ListDtoSchema, SetDtoSchema, type HistoryDto, type ListDto, type SetDto } from "./dto";

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

/** Whether the server can be used for labels at all. Never an HTTP error: see `labelStatus`. */
export type StatusResult = { kind: "available" } | { kind: "signed-out" } | { kind: "unavailable"; message: string };

export interface LabelClient {
  status(): Promise<StatusResult>;
  /** Every opened set of the active org; read-only. */
  list(): Promise<LabelResult<ListDto>>;
  /** The decision history of every decided set of the active org; read-only (the Review board). */
  history(): Promise<LabelResult<HistoryDto>>;
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
  /** Everything that is not a 200: one place decides what each HTTP status means. */
  function failure(res: Response, parsed: unknown): LabelResult<never> {
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

  async function request<T>(method: "GET" | "POST", url: string, parse: (v: unknown) => T | null, body?: unknown, keepalive = false): Promise<LabelResult<T>> {
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
    if (res.status !== 200) return failure(res, parsed);
    const value = parse(parsed);
    return value === null ? { kind: "unavailable", retryAfterMs: null, message: "unexpected response from the server" } : { kind: "ok", value };
  }

  const parseSet = (v: unknown): SetDto | null => {
    const r = SetDtoSchema.safeParse(v);
    return r.success ? r.data : null;
  };
  const parseList = (v: unknown): ListDto | null => {
    const r = ListDtoSchema.safeParse(v);
    return r.success ? r.data : null;
  };
  const parseHistory = (v: unknown): HistoryDto | null => {
    const r = HistoryDtoSchema.safeParse(v);
    return r.success ? r.data : null;
  };
  const call = (method: "GET" | "POST", imageId: string, action: string, body?: unknown, keepalive = false): Promise<LabelResult> =>
    request(method, `${base}/${encodeURIComponent(imageId)}${action}`, parseSet, body, keepalive);

  async function status(): Promise<StatusResult> {
    try {
      const res = await fetchImpl(`${base}/status`, { method: "GET", headers: { accept: "application/json" }, credentials: "same-origin" });
      const b = (await res.json()) as { available?: unknown; reason?: unknown };
      if (res.status === 200 && b.available === true) return { kind: "available" };
      if (res.status === 200 && b.available === false) return b.reason === "signed-out" ? { kind: "signed-out" } : { kind: "unavailable", message: "The server is not available for labels right now." };
      return { kind: "unavailable", message: `Server answered HTTP ${res.status}` };
    } catch (e) {
      return { kind: "unavailable", message: e instanceof Error ? e.message : "network error" };
    }
  }

  return {
    status,
    list: () => request("GET", base, parseList),
    history: () => request("GET", `${base}/history`, parseHistory),
    get: (id) => call("GET", id, ""),
    open: (id) => call("POST", id, "/open", {}),
    ops: (id, baseVersion, ops, opts) => call("POST", id, "/ops", { baseVersion, ops }, opts?.keepalive),
    transition: (id, input) => call("POST", id, "/transition", input),
  };
}
