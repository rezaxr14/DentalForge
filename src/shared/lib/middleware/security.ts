/**
 * Security middleware: rate limiting + CSRF + body-size.
 *
 * Usage in a route:
 *   const guard = createSecurityGuard({ max: 60, windowMs: 60_000 });
 *   const res = await guard.check(req, "jobs:create");
 *   if (!res.ok) return res.response;
 */

import { createRateLimiter, isSameOrigin, type RateLimitResult } from "@/shared/lib/rate-limit";
import { CONTENT_SECURITY_POLICY } from "@/shared/lib/csp";

export interface SecurityOptions {
  /** Rate limit key prefix (e.g., "jobs:create"). */
  key: string;
  /** Max requests per window (default 60). */
  max?: number;
  /** Window in ms (default 60_000). */
  windowMs?: number;
  /** Require CSRF check (default true for mutating methods). */
  requireCsrf?: boolean;
  /** Max body size in bytes (default 1MB). */
  maxBodySize?: number;
}

export interface SecurityResult {
  ok: boolean;
  /** The Response to return if !ok. Never null - throws if ok. */
  response: Response;
  /** Rate limit info (for headers). */
  rateLimit: RateLimitResult;
}

/**
 * Creates a security guard for a route.
 * - Rate limits by IP + key
 * - CSRF check for mutating methods (cookie auth)
 * - Body size limit
 */
export function createSecurityGuard(opts: SecurityOptions) {
  const appOrigin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const limiter = createRateLimiter({ max: opts.max ?? 60, windowMs: opts.windowMs ?? 60_000 });

  return {
    /**
     * Check the request. Returns { ok: true } or { ok: false, response: 429/403/413 }.
     */
    async check(req: Request, ip?: string): Promise<SecurityResult> {
      const clientIp = ip ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const key = `${opts.key}:${clientIp}`;

      // 1. Rate limit
      const rl = limiter.check(key);
      if (!rl.ok) {
        return {
          ok: false,
          rateLimit: rl,
          response: new Response(JSON.stringify({ error: "Too many requests" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)),
            },
          }),
        };
      }

      // 2. CSRF for mutating methods (POST/PUT/PATCH/DELETE)
      if (opts.requireCsrf !== false && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        if (!isSameOrigin(req, appOrigin)) {
          return {
            ok: false,
            rateLimit: rl,
            response: new Response(JSON.stringify({ error: "Invalid origin" }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          };
        }
      }

      // 3. Body size limit (streaming check)
      if (opts.maxBodySize !== undefined && req.method !== "GET" && req.method !== "HEAD") {
        const cl = req.headers.get("content-length");
        if (cl) {
          const len = parseInt(cl, 10);
          if (len > opts.maxBodySize) {
            return {
              ok: false,
              rateLimit: rl,
              response: new Response(JSON.stringify({ error: "Payload too large" }), {
                status: 413,
                headers: { "content-type": "application/json" },
              }),
            };
          }
        }
        // For streaming without content-length, we can't check upfront
        // The route handler should use a size-limited stream consumer
      }

      // Success: return a dummy response that won't be used, but satisfies the type
      // The caller should check ok and only use rateLimit
      return {
        ok: true,
        rateLimit: rl,
        response: new Response(null, { status: 204 }), // Never actually used
      };
    },

    /** Reset all buckets (for demo reset). */
    reset() {
      limiter.reset();
    },
  };
}

/**
 * Creates standard security headers for responses.
 */
export function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // The same policy next.config.ts sends (src/shared/lib/csp.ts), for responses built outside the Next pipeline.
    "content-security-policy": CONTENT_SECURITY_POLICY,
  };
}