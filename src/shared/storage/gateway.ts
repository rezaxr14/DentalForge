/**
 * Local storage gateway (`/api/storage/[...key]`) — framework-free handlers.
 *
 * Only a signed URL (see ./signing.ts) opens these. PUT additionally pins the
 * body to the size and SHA-256 that were signed, so a URL holder cannot store
 * different bytes under a content-hash key. Only meaningful for the local
 * adapter; with R2/Blob the provider's own presigned URLs are used instead.
 */
import { problem } from "@/shared/jobs/problem";
import { sha256Hex, type StorageAdapter } from "./adapter";
import { verifySignedUrl } from "./signing";

const MAX_PUT_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
  onnx: "application/octet-stream",
};

function reasonStatus(reason: string): number {
  // A bad key is a malformed request; everything else is "you may not do this".
  return reason === "bad_key" ? 400 : 403;
}

export async function putObject(
  req: Request,
  key: string,
  storage: StorageAdapter,
  secret: string,
  nowSeconds?: number,
): Promise<Response> {
  if (storage.provider !== "local") return problem(404, "not_found", "Not found");
  const v = verifySignedUrl(new URL(req.url), key, "put", secret, nowSeconds);
  if (!v.ok) return problem(reasonStatus(v.reason), "forbidden", "Invalid or expired upload URL", v.reason);
  const { bytes, sha256 } = v.claims;
  if (bytes === undefined || sha256 === undefined) {
    return problem(400, "invalid_request", "Upload URL must pin size and sha256");
  }
  if (bytes > MAX_PUT_BYTES) return problem(413, "invalid_request", "Object too large");
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > bytes) return problem(413, "invalid_request", "Body larger than the signed size");
  const body = Buffer.from(await req.arrayBuffer());
  if (body.byteLength !== bytes) {
    return problem(422, "validation_failed", "Body size does not match the signed size", `expected ${bytes}, got ${body.byteLength}`);
  }
  if (sha256Hex(body) !== sha256) {
    return problem(422, "validation_failed", "Body hash does not match the signed sha256");
  }
  await storage.write(key, body, v.claims.mime ?? "application/octet-stream");
  return new Response(JSON.stringify({ ok: true, key, bytes }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function getObject(
  req: Request,
  key: string,
  storage: StorageAdapter,
  secret: string,
  nowSeconds?: number,
): Promise<Response> {
  if (storage.provider !== "local") return problem(404, "not_found", "Not found");
  const v = verifySignedUrl(new URL(req.url), key, "get", secret, nowSeconds);
  if (!v.ok) return problem(reasonStatus(v.reason), "forbidden", "Invalid or expired download URL", v.reason);
  const data = await storage.read(key);
  if (!data) return problem(404, "not_found", "Object not found");
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=60",
      // Never let a stored blob be sniffed into something executable.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
