/**
 * RFC 9457 `application/problem+json` responses (plan §10: "Errors are
 * problem+json"). Every API error in the job/worker surface goes through
 * here so clients get one stable shape: `{type, title, status, code, detail}`.
 */
import type { JobWriteFailure } from "@/shared/db/repos";

export type ProblemCode =
  | "invalid_request"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "unknown_worker"
  | "not_found"
  | "unsupported_contract_version"
  | "job_not_owner"
  | "job_cancelled"
  | "job_terminal"
  | "worker_integration_off"
  | "unavailable"
  | "not_implemented"
  | "internal";

export function problem(
  status: number,
  code: ProblemCode,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: `urn:traceforge:problem:${code}`, title, status, code, ...(detail ? { detail } : {}), ...extra }),
    { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store", ...headers } },
  );
}

/** Map a refused worker-side job write to its problem response. */
export function jobWriteProblem(code: JobWriteFailure): Response {
  switch (code) {
    case "not_found":
      return problem(404, "not_found", "Job not found");
    case "not_owner":
      return problem(
        409,
        "job_not_owner",
        "You no longer hold this job's lease",
        "The lease expired and the job was requeued or leased to another worker. Stop working on it.",
      );
    case "cancelled":
      return problem(409, "job_cancelled", "Job was cancelled", "Stop working on it and drop any partial output.");
    case "terminal":
      return problem(409, "job_terminal", "Job already finished");
  }
}

export function validationProblem(issues: string[]): Response {
  return problem(422, "validation_failed", "Request validation failed", issues.slice(0, 8).join("; "), { issues: issues.slice(0, 20) });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** Parse a JSON body; returns a problem Response on malformed input. */
export async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  try {
    const text = await req.text();
    if (text.length > 1_000_000) {
      return { ok: false, res: problem(413, "invalid_request", "Request body too large") };
    }
    return { ok: true, value: text.length === 0 ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, res: problem(400, "invalid_request", "Malformed JSON body") };
  }
}
