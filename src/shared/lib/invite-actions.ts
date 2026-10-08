/**
 * Invite link server actions (plan D7, §11.9) — "use server" boundary over
 * the signed-link primitives in `./invites` (mint/verify/hash).
 *
 * Both actions return a serializable `Result`-shaped object and never throw
 * for expected conditions (plan §9.4 rule 2): signed-out / forbidden /
 * offline / consumed are data, not exceptions.
 */
"use server";

import { z } from "zod";
import { getSession } from "@/shared/auth/session";
import { getEnv } from "@/shared/config/env";
import { selectOrgStore } from "@/shared/db";
import { can, Role } from "@/shared/domain/auth";
import { hashToken, mintInvite, verifyInvite } from "./invites";

const CreateInviteInput = z.object({
  orgId: z.string().min(1),
  role: Role,
  maxUses: z.number().int().min(1).max(100).default(1).optional(),
  /** Hours until expiry (default 72h). */
  ttlHours: z.number().int().min(1).max(24 * 30).default(72).optional(),
});

type CreateInviteArgs = z.input<typeof CreateInviteInput>;

export interface InviteLinkResult {
  ok: boolean;
  /** Full relative link the admin copies (`/invite/<token>`). */
  link?: string;
  reason?: string;
}

/**
 * Mint a signed, expiring, use-limited invite link. Admin-only
 * (`can("member.invite")`); persists only the sha256 hash.
 */
export async function createInviteLink(input: CreateInviteArgs): Promise<InviteLinkResult> {
  const parsed = CreateInviteInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };
  const session = await getSession();
  if (!session) return { ok: false, reason: "signed-out" };
  let store;
  try {
    store = await selectOrgStore();
  } catch {
    return { ok: false, reason: "offline" };
  }
  const membership = await store.membership(session.user.id, parsed.data.orgId);
  if (!membership || !can(membership.role, "member.invite")) return { ok: false, reason: "forbidden" };
  const maxUses = parsed.data.maxUses ?? 1;
  const ttlHours = parsed.data.ttlHours ?? 72;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const { token, tokenHash } = mintInvite(
    { orgId: parsed.data.orgId, role: parsed.data.role, expiresAt },
    getEnv().INVITE_SIGNING_SECRET,
  );
  try {
    await store.scoped(parsed.data.orgId).createInvite({
      orgId: parsed.data.orgId,
      email: "",
      role: parsed.data.role,
      status: "pending",
      tokenHash,
      expiresAt: new Date(expiresAt * 1000),
      maxUses,
      uses: 0,
      inviterId: session.user.id,
    });
    await store.scoped(parsed.data.orgId).appendAudit({
      actorId: session.user.id,
      action: "invite.create",
      meta: { role: parsed.data.role, maxUses, ttlHours },
    });
  } catch {
    return { ok: false, reason: "offline" };
  }
  return { ok: true, link: `/invite/${token}` };
}

export interface AcceptInviteResult {
  ok: boolean;
  orgId?: string;
  reason?: string;
}

/**
 * Accept a signed invite link: verifies the HMAC, consumes one use
 * atomically, then grants the membership. Idempotent — already-a-member
 * returns ok without consuming a use. Requires a signed-in user.
 */
export async function acceptInviteLink(token: string): Promise<AcceptInviteResult> {
  const verified = verifyInvite(token, getEnv().INVITE_SIGNING_SECRET);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const session = await getSession();
  if (!session) return { ok: false, reason: "signed-out" };
  let store;
  try {
    store = await selectOrgStore();
  } catch {
    return { ok: false, reason: "offline" };
  }
  const existing = await store.membership(session.user.id, verified.claims.orgId);
  if (existing) return { ok: true, orgId: verified.claims.orgId };
  const invite = await store.scoped(verified.claims.orgId).consumeInvite(hashToken(token));
  if (!invite) return { ok: false, reason: "consumed" };
  try {
    await store.addMember({ userId: session.user.id, orgId: invite.orgId, role: invite.role });
    await store.scoped(invite.orgId).appendAudit({
      actorId: session.user.id,
      action: "invite.accept",
      meta: { role: invite.role },
    });
  } catch {
    return { ok: false, reason: "offline" };
  }
  return { ok: true, orgId: invite.orgId };
}
