/**
 * Worker-token server actions (M8 task B) — thin "use server" boundary over
 * `@/shared/jobs/token-admin`. Same shape as `invite-actions.ts`: session →
 * store → core, with every expected condition returned as data.
 *
 * The raw token appears only in the `createWorkerTokenAction` response and is
 * never logged, audited or stored.
 */
"use server";

import { getSession } from "@/shared/auth/session";
import { isDegradedStore, selectOrgStore } from "@/shared/db";
import {
  createTokenForAdmin,
  listTokensForAdmin,
  revokeTokenForAdmin,
  type CreateTokenInput,
  type TokenAdminResult,
  type WorkerTokenSummary,
} from "@/shared/jobs/token-admin";

type Ctx = { store: Awaited<ReturnType<typeof selectOrgStore>>; actorId: string };
type CtxResult = { ok: true; ctx: Ctx } | { ok: false; code: "forbidden" | "offline"; reason: string };

async function context(): Promise<CtxResult> {
  const session = await getSession();
  if (!session) return { ok: false, code: "forbidden", reason: "Sign in first." };
  let store;
  try {
    store = await selectOrgStore();
  } catch {
    return { ok: false, code: "offline", reason: "The database is unreachable." };
  }
  // Tokens minted into the in-memory fallback would vanish on restart and could never
  // authenticate a worker against the real database: refuse instead of pretending.
  if (isDegradedStore(store)) {
    return { ok: false, code: "offline", reason: "The database is unreachable; worker tokens need a durable store." };
  }
  return { ok: true, ctx: { store, actorId: session.user.id } };
}

export async function listWorkerTokensAction(
  orgId: string,
): Promise<TokenAdminResult<{ tokens: WorkerTokenSummary[] }>> {
  const c = await context();
  if (!c.ok) return c;
  return listTokensForAdmin(c.ctx.store, c.ctx.actorId, orgId);
}

export async function createWorkerTokenAction(
  orgId: string,
  input: CreateTokenInput,
): Promise<TokenAdminResult<{ token: string; created: WorkerTokenSummary; tokens: WorkerTokenSummary[] }>> {
  const c = await context();
  if (!c.ok) return c;
  return createTokenForAdmin(c.ctx.store, c.ctx.actorId, orgId, input);
}

export async function revokeWorkerTokenAction(
  orgId: string,
  tokenId: string,
): Promise<TokenAdminResult<{ tokens: WorkerTokenSummary[] }>> {
  const c = await context();
  if (!c.ok) return c;
  return revokeTokenForAdmin(c.ctx.store, c.ctx.actorId, orgId, tokenId);
}
