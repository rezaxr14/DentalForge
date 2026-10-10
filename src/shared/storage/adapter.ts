/**
 * Storage adapter (plan §5, §9.4 rule 4).
 *
 * `StorageAdapter` fronts object storage for images/artifacts/ONNX. The app
 * boots with the local adapter when R2/Blob creds are absent; callers never
 * branch on the provider. Large payloads never pass through Vercel functions
 * — `presignUpload`/`presignDownload` return URLs the worker/browser PUT/GET
 * directly (plan §5 principles).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEnv } from "@/shared/config/env";
import { signedQuery } from "./signing";

export type StorageProvider = "r2" | "blob" | "local";

export interface PresignedUpload {
  /** Key under which the object will live. */
  key: string;
  /** URL to PUT the bytes to. Local adapter: a same-origin API route. */
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface StorageAdapter {
  readonly provider: StorageProvider;
  /** `prefix` namespaces the key (the worker API passes the org id so keys are tenant-scoped). */
  presignUpload(input: { name: string; mime: string; bytes: number; sha256: string; prefix?: string }): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds?: number): Promise<string>;
  read(key: string): Promise<Buffer | null>;
  write(key: string, data: Buffer, mime: string): Promise<void>;
}

function contentKey(name: string, sha256: string, prefix?: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "object";
  const base = `artifacts/${sha256.slice(0, 2)}/${sha256.slice(2, 10)}/${safe}`;
  return prefix ? `${prefix}/${base}` : base;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Local-disk adapter (dev default). Bytes live under
 * `<repo>/public/demo-assets/<key>`; presigned URLs point at the
 * `/api/storage/[...key]` gateway, which verifies an HMAC-signed, expiring,
 * operation-bound query (see ./signing.ts) before touching disk. URLs are
 * RELATIVE; the worker API absolutizes them against the request origin.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = "local" as const;
  private readonly root: string;
  private readonly secretOverride: string | undefined;
  private readonly now: () => number;

  constructor(
    root = join(process.cwd(), "public", "demo-assets"),
    opts: { secret?: string; now?: () => number } = {},
  ) {
    this.root = root;
    this.secretOverride = opts.secret;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private secret(): string {
    return this.secretOverride ?? getEnv().BETTER_AUTH_SECRET;
  }

  async presignUpload(input: {
    name: string;
    mime: string;
    bytes: number;
    sha256: string;
    prefix?: string;
  }): Promise<PresignedUpload> {
    const key = contentKey(input.name, input.sha256, input.prefix);
    const q = signedQuery(
      { key, op: "put", exp: this.now() + 15 * 60, mime: input.mime, bytes: input.bytes, sha256: input.sha256 },
      this.secret(),
    );
    return { key, uploadUrl: `/api/storage/${key}?${q}`, headers: { "content-type": input.mime } };
  }

  async presignDownload(key: string, ttlSeconds = 300): Promise<string> {
    const q = signedQuery({ key, op: "get", exp: this.now() + ttlSeconds }, this.secret());
    return `/api/storage/${key}?${q}`;
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return readFileSync(join(this.root, key));
    } catch {
      return null;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const path = join(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
}

/** Stub for the Cloudflare R2 (S3 API) adapter — real client lands with M7 imports. */
export class R2StorageAdapter implements StorageAdapter {
  readonly provider = "r2" as const;
  constructor(private readonly bucket: string) {}
  async presignUpload(input: { name: string; mime: string; bytes: number; sha256: string; prefix?: string }): Promise<PresignedUpload> {
    void input;
    void this.bucket;
    throw new Error("R2 adapter not configured (missing R2 credentials); local adapter in use");
  }
  async presignDownload(): Promise<string> {
    throw new Error("R2 adapter not configured (missing R2 credentials); local adapter in use");
  }
  async read(): Promise<Buffer | null> {
    throw new Error("R2 adapter not configured (missing R2 credentials); local adapter in use");
  }
  async write(): Promise<void> {
    throw new Error("R2 adapter not configured (missing R2 credentials); local adapter in use");
  }
}

export function newStorageId(): string {
  return randomUUID();
}
