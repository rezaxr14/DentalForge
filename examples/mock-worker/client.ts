/**
 * Tiny worker-contract client (fetch only). Mirrors what the Python reference
 * worker does, so the same wire behavior is exercised from two languages.
 */
import { createHash } from "node:crypto";

export class ContractError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  /** The lease is gone or the job was cancelled/finished: stop working on it. */
  get lostJob(): boolean {
    return this.status === 409;
  }
}

export interface ClaimedJob {
  id: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  attempt: number;
  leaseExpiresAt: string;
}

export class WorkerClient {
  workerId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
      "x-contract-version": "1",
      ...extraHeaders,
    };
    if (this.workerId) headers["x-worker-id"] = this.workerId;
    const res = await this.fetchFn(`${this.baseUrl}/api/worker/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code = "unknown";
      let detail = res.statusText;
      try {
        const p = (await res.json()) as { code?: string; title?: string; detail?: string };
        code = p.code ?? code;
        detail = p.detail ?? p.title ?? detail;
      } catch {
        /* non-JSON error body */
      }
      const ra = Number(res.headers.get("retry-after"));
      throw new ContractError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${detail}`, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return (await res.json()) as T;
  }

  async register(name: string, runtime: string, capabilities: { job: string; versions?: number[]; models?: string[] }[]) {
    const r = await this.call<{ workerId: string; pollIntervalMs: number; leaseSeconds: number }>("POST", "/register", {
      name,
      runtime,
      software: { python: "n/a (mock)" },
      capabilities,
    });
    this.workerId = r.workerId;
    return r;
  }

  heartbeat(status: "idle" | "busy") {
    return this.call<{ cancelJobIds: string[] }>("POST", "/heartbeat", { workerId: this.workerId, status });
  }

  async claim(accepts: string[], waitMs: number): Promise<ClaimedJob[]> {
    const r = await this.call<{ jobs: ClaimedJob[] }>("POST", "/jobs/claim", { workerId: this.workerId, accepts, max: 1, waitMs });
    return r.jobs;
  }

  postEvents(jobId: string, events: { seq: number; type: string; data: unknown }[]) {
    return this.call<{ accepted: number }>("POST", `/jobs/${jobId}/events`, { events });
  }

  complete(jobId: string, result: unknown, artifactIds: string[] = []) {
    return this.call<{ ok: true }>("POST", `/jobs/${jobId}/complete`, { result, artifactIds });
  }

  fail(jobId: string, error: { code: string; message: string; retryable: boolean }) {
    return this.call<{ ok: true; attemptsRemaining: number }>("POST", `/jobs/${jobId}/fail`, { error });
  }

  /** Presign, then PUT the bytes to the returned URL. Returns the artifact id. */
  async uploadArtifact(jobId: string, name: string, mime: string, bytes: Buffer): Promise<string> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const p = await this.call<{ artifactId: string; uploadUrl: string; headers: Record<string, string> }>(
      "POST",
      `/jobs/${jobId}/artifacts/presign`,
      { name, mime, bytes: bytes.length, sha256 },
    );
    const put = await this.fetchFn(p.uploadUrl, { method: "PUT", headers: p.headers, body: new Uint8Array(bytes) });
    if (!put.ok) throw new ContractError(put.status, "upload_failed", `artifact PUT → ${put.status}`);
    return p.artifactId;
  }
}
