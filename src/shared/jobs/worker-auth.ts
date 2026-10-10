/**
 * Worker request authentication (plan §10 preamble).
 *
 *   1. `X-Contract-Version` must be present; unknown MAJOR → 426.
 *   2. `Authorization: Bearer tf_wrk_…` → hashed → org + scope.
 *   3. Scope ladder: jobs:read < jobs:write < admin.
 *   4. Job-write endpoints also need `X-Worker-Id` naming a worker of THIS org
 *      (the lease-ownership fence — see ADR-0009).
 *
 * Returns the authenticated context, or a ready problem+json Response.
 */
import { CONTRACT_VERSION } from "@/shared/contracts/worker";
import { WORKER_ID_HEADER } from "@/shared/contracts/worker";
import type { OrgRecord, OrgStore, ScopedRepos, WorkerRecord, WorkerTokenRecord } from "@/shared/db/repos";
import { hashToken } from "@/shared/lib/invites";
import { problem } from "./problem";
import { parseBearer } from "./tokens";

export type WorkerScope = WorkerTokenRecord["scopes"];
const RANK: Record<WorkerScope, number> = { "jobs:read": 1, "jobs:write": 2, admin: 3 };

export interface WorkerAuth {
  org: OrgRecord;
  token: WorkerTokenRecord;
  repos: ScopedRepos;
}

export async function authenticateWorker(
  req: Request,
  store: OrgStore,
  need: WorkerScope,
): Promise<WorkerAuth | Response> {
  const v = req.headers.get("x-contract-version");
  if (v === null) {
    return problem(400, "invalid_request", "Missing X-Contract-Version header", `Send X-Contract-Version: ${CONTRACT_VERSION}`);
  }
  const major = Number.parseInt(v, 10);
  if (!Number.isInteger(major) || major !== CONTRACT_VERSION) {
    return problem(426, "unsupported_contract_version", "Unsupported contract version", `This server speaks contract v${CONTRACT_VERSION}.`, {
      supported: [CONTRACT_VERSION],
    }, { upgrade: `traceforge-worker/${CONTRACT_VERSION}` });
  }

  const raw = parseBearer(req.headers.get("authorization"));
  if (!raw) {
    return problem(401, "unauthorized", "Missing or malformed worker token", undefined, {}, { "www-authenticate": 'Bearer realm="traceforge-worker"' });
  }
  const found = await store.findOrgByWorkerTokenHash(hashToken(raw));
  if (!found) {
    return problem(401, "unauthorized", "Invalid or revoked worker token", undefined, {}, { "www-authenticate": 'Bearer realm="traceforge-worker"' });
  }
  if (RANK[found.token.scopes] < RANK[need]) {
    return problem(403, "forbidden", "Token scope is insufficient", `This endpoint needs ${need}; the token has ${found.token.scopes}.`);
  }
  return { org: found.org, token: found.token, repos: store.scoped(found.org.id) };
}

/** Resolve `X-Worker-Id` to a worker of the authenticated org. */
export async function requireWorker(req: Request, auth: WorkerAuth): Promise<WorkerRecord | Response> {
  const id = req.headers.get(WORKER_ID_HEADER);
  if (!id) {
    return problem(400, "invalid_request", `Missing ${WORKER_ID_HEADER} header`, "Send the workerId returned by /register.");
  }
  // Ids are uuids; reject junk before it reaches a `uuid` column comparison.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return problem(403, "unknown_worker", "Unknown worker", "Register again to obtain a workerId.");
  }
  const w = await auth.repos.getWorker(id);
  if (!w) return problem(403, "unknown_worker", "Unknown worker", "Register again to obtain a workerId.");
  return w;
}
