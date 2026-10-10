/**
 * Worker-token administration (plan §5.2, §10, M8 task B).
 *
 * Framework-free core behind the `/settings` server actions: authorization via
 * the single `can()` gate, org scoping via `store.scoped(orgId)`, an audit
 * entry for every privileged change, and Result-shaped outcomes (expected
 * conditions are data, never thrown — plan §9.4).
 *
 * Security properties this module guarantees (and tests/m8-token-admin.test.ts
 * pins on both stores):
 *  - the raw token is returned exactly once, by `createTokenForAdmin`; it is
 *    never listed, never audited and never persisted (only its SHA-256);
 *  - list/revoke only ever see the caller's org (a foreign token id is
 *    `not_found`, indistinguishable from a missing one);
 *  - a token whose creation could not be audited is revoked again and never
 *    handed out.
 */
import { can, type Action } from "@/shared/domain/auth";
import type { OrgStore, WorkerTokenRecord } from "@/shared/db/repos";
import { mintWorkerToken } from "./tokens";
import {
  CreateTokenInput,
  MAX_ACTIVE_TOKENS,
  type WorkerTokenSummary,
} from "./token-types";

export * from "./token-types";

export type TokenAdminCode = "forbidden" | "invalid-input" | "not_found" | "limit_reached" | "offline";

export type TokenAdminResult<T> = ({ ok: true } & T) | { ok: false; code: TokenAdminCode; reason: string };

const fail = (code: TokenAdminCode, reason: string): { ok: false; code: TokenAdminCode; reason: string } => ({
  ok: false,
  code,
  reason,
});

export function summarize(t: WorkerTokenRecord): WorkerTokenSummary {
  return {
    id: t.id,
    name: t.name,
    scope: t.scopes,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
  };
}

/** Active tokens first, newest first within each group. */
export function sortTokens(tokens: WorkerTokenSummary[]): WorkerTokenSummary[] {
  return [...tokens].sort((a, b) => {
    const ra = a.revokedAt ? 1 : 0;
    const rb = b.revokedAt ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Non-members and under-privileged members get the same answer (no org enumeration). */
async function authorize(store: OrgStore, actorId: string, orgId: string, action: Action): Promise<boolean> {
  const membership = await store.membership(actorId, orgId);
  return membership !== null && can(membership.role, action);
}

export async function listTokensForAdmin(
  store: OrgStore,
  actorId: string,
  orgId: string,
): Promise<TokenAdminResult<{ tokens: WorkerTokenSummary[] }>> {
  try {
    if (!(await authorize(store, actorId, orgId, "worker.listTokens"))) {
      return fail("forbidden", "Only admins can manage worker tokens.");
    }
    const rows = await store.scoped(orgId).listWorkerTokens();
    return { ok: true, tokens: sortTokens(rows.map(summarize)) };
  } catch {
    return fail("offline", "The database is unreachable.");
  }
}

export async function createTokenForAdmin(
  store: OrgStore,
  actorId: string,
  orgId: string,
  input: CreateTokenInput,
): Promise<TokenAdminResult<{ token: string; created: WorkerTokenSummary; tokens: WorkerTokenSummary[] }>> {
  const parsed = CreateTokenInput.safeParse(input);
  if (!parsed.success) {
    return fail("invalid-input", parsed.error.issues[0]?.message ?? "Invalid input.");
  }
  try {
    if (!(await authorize(store, actorId, orgId, "worker.createToken"))) {
      return fail("forbidden", "Only admins can manage worker tokens.");
    }
    const repos = store.scoped(orgId);
    const active = (await repos.listWorkerTokens()).filter((t) => !t.revokedAt).length;
    if (active >= MAX_ACTIVE_TOKENS) {
      return fail("limit_reached", `This organization already has ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
    }

    const { token, tokenHash } = mintWorkerToken();
    const record = await repos.createWorkerToken({ name: parsed.data.name, tokenHash, scopes: parsed.data.scope });
    try {
      // The audit row never contains the token or its hash.
      await repos.appendAudit({
        actorId,
        action: "worker.token.create",
        resource: record.id,
        meta: { name: record.name, scope: record.scopes },
      });
    } catch {
      // A privileged change we cannot audit must not exist: retire it and hand nothing out.
      await repos.revokeWorkerToken(record.id).catch(() => false);
      return fail("offline", "The audit log is unavailable; the token was not created.");
    }
    const tokens = sortTokens((await repos.listWorkerTokens()).map(summarize));
    return { ok: true, token, created: summarize(record), tokens };
  } catch {
    return fail("offline", "The database is unreachable.");
  }
}

export async function revokeTokenForAdmin(
  store: OrgStore,
  actorId: string,
  orgId: string,
  tokenId: string,
): Promise<TokenAdminResult<{ tokens: WorkerTokenSummary[] }>> {
  try {
    if (!(await authorize(store, actorId, orgId, "worker.revokeToken"))) {
      return fail("forbidden", "Only admins can manage worker tokens.");
    }
    const repos = store.scoped(orgId);
    // Look the token up in THIS org first: a foreign or unknown id is simply not_found
    // (and a non-uuid string never reaches a uuid column).
    const target = (await repos.listWorkerTokens()).find((t) => t.id === tokenId);
    if (!target || target.revokedAt) return fail("not_found", "No active token with that id.");
    if (!(await repos.revokeWorkerToken(target.id))) return fail("not_found", "No active token with that id.");
    await repos
      .appendAudit({ actorId, action: "worker.token.revoke", resource: target.id, meta: { name: target.name, scope: target.scopes } })
      .catch(() => undefined); // revocation is the safe direction: never undo it because the log hiccuped
    const tokens = sortTokens((await repos.listWorkerTokens()).map(summarize));
    return { ok: true, tokens };
  } catch {
    return fail("offline", "The database is unreachable.");
  }
}
