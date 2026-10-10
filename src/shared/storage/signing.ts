/**
 * Signed URLs for the local storage gateway (`/api/storage/[...key]`).
 *
 * The gateway is the dev/no-R2 stand-in for S3 presigned URLs, so it must
 * enforce the same guarantees: a URL is bound to ONE operation on ONE key,
 * expires, and (for uploads) pins the expected size and SHA-256 so a holder
 * of the URL cannot write different bytes under a content-hash key.
 *
 * The HMAC key is derived from the app secret with a domain-separation label
 * so a storage signature can never be replayed as any other signed value.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type StorageOp = "put" | "get";

export interface StorageClaims {
  key: string;
  op: StorageOp;
  /** Unix seconds. */
  exp: number;
  mime?: string;
  bytes?: number;
  sha256?: string;
}

const LABEL = "traceforge-storage-url-v1";

function derive(secret: string): Buffer {
  return createHmac("sha256", secret).update(LABEL).digest();
}

function canonical(c: StorageClaims): string {
  return [c.op, c.key, String(c.exp), c.mime ?? "", c.bytes === undefined ? "" : String(c.bytes), c.sha256 ?? ""].join("\n");
}

function sign(c: StorageClaims, secret: string): string {
  return createHmac("sha256", derive(secret)).update(canonical(c)).digest("base64url");
}

/** Query string (no leading `?`) to append to `/api/storage/<key>`. */
export function signedQuery(c: StorageClaims, secret: string): string {
  const q = new URLSearchParams({ op: c.op, exp: String(c.exp) });
  if (c.mime) q.set("mime", c.mime);
  if (c.bytes !== undefined) q.set("bytes", String(c.bytes));
  if (c.sha256) q.set("sha256", c.sha256);
  q.set("sig", sign(c, secret));
  return q.toString();
}

export type VerifyResult =
  | { ok: true; claims: StorageClaims }
  | { ok: false; reason: "missing" | "bad_signature" | "expired" | "wrong_operation" | "bad_key" };

/** Reject traversal and absolute paths before the key ever touches the filesystem. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function verifySignedUrl(
  url: URL,
  key: string,
  expectedOp: StorageOp,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!isSafeKey(key)) return { ok: false, reason: "bad_key" };
  const p = url.searchParams;
  const op = p.get("op");
  const exp = Number(p.get("exp"));
  const sig = p.get("sig");
  if (!op || !sig || !Number.isFinite(exp)) return { ok: false, reason: "missing" };
  if (op !== expectedOp) return { ok: false, reason: "wrong_operation" };
  const claims: StorageClaims = {
    key,
    op: expectedOp,
    exp,
    mime: p.get("mime") ?? undefined,
    bytes: p.has("bytes") ? Number(p.get("bytes")) : undefined,
    sha256: p.get("sha256") ?? undefined,
  };
  const want = Buffer.from(sign(claims, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  if (exp < nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
