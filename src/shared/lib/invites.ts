/**
 * Invite links (plan D7, §7 `invites`).
 *
 * Signed, expiring, use-limited single-org invite tokens. Format:
 * `tf_inv_<inviteId>_<random>` — the random part is stored hashed (sha256),
 * so a leaked DB dump cannot mint memberships. Signature binds
 * (inviteId, orgId, role, expiresAt) under INVITE_SIGNING_SECRET.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Role } from "../domain/auth";

export const INVITE_TOKEN_PREFIX = "tf_inv_";

export interface InviteClaims {
  inviteId: string;
  orgId: string;
  role: Role;
  /** Unix seconds. */
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function unb64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Mint a fresh invite token + the hash to persist. */
export function mintInvite(
  claims: Omit<InviteClaims, "inviteId"> & { inviteId?: string },
  secret: string,
): { token: string; tokenHash: string; claims: InviteClaims } {
  const inviteId = claims.inviteId ?? randomBytes(12).toString("hex");
  const full: InviteClaims = { ...claims, inviteId };
  const payload = b64url(JSON.stringify(full));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  const random = randomBytes(16).toString("hex");
  const token = `${INVITE_TOKEN_PREFIX}${inviteId}_${random}.${payload}.${sig}`;
  return { token, tokenHash: hashToken(token), claims: full };
}

/** Verify structure + signature + expiry. Returns claims or a reason. */
export function verifyInvite(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true; claims: InviteClaims } | { ok: false; reason: string } {
  if (!token.startsWith(INVITE_TOKEN_PREFIX)) return { ok: false, reason: "bad-prefix" };
  const rest = token.slice(INVITE_TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  const dot2 = rest.lastIndexOf(".", dot - 1);
  if (dot < 0 || dot2 < 0) return { ok: false, reason: "bad-format" };
  const payload = rest.slice(dot2 + 1, dot);
  const sig = rest.slice(dot + 1);
  let expected: Buffer;
  try {
    expected = createHmac("sha256", secret).update(payload).digest();
  } catch {
    return { ok: false, reason: "bad-secret" };
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "bad-signature-encoding" };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  let claims: InviteClaims;
  try {
    claims = JSON.parse(unb64url(payload).toString("utf-8")) as InviteClaims;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  const role = Role.safeParse(claims.role);
  if (!role.success || typeof claims.inviteId !== "string" || typeof claims.orgId !== "string") {
    return { ok: false, reason: "bad-claims" };
  }
  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
