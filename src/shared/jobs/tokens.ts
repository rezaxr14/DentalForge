/** Worker bearer tokens (plan §10: `tf_wrk_<random>`, stored hashed, org-scoped). */
import { randomBytes } from "node:crypto";
import { hashToken } from "@/shared/lib/invites";

export const WORKER_TOKEN_PREFIX = "tf_wrk_";

/** The raw token is shown ONCE to the admin; only its SHA-256 is stored. */
export function mintWorkerToken(): { token: string; tokenHash: string } {
  const token = WORKER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const tok = m?.[1];
  return tok && tok.startsWith(WORKER_TOKEN_PREFIX) ? tok : null;
}
