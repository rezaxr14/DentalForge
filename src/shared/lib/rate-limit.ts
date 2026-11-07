/**
 * In-process rate limiter (WP8 hardening primitive).
 *
 * Sliding window per key. Used as a conservative fallback when Upstash Redis REST
 * is not configured; a single instance limiter is not shared across Vercel
 * instances, which is acceptable for a portfolio demo (the plan allows this).
 *
 * Returns `{ ok, remaining, retryAfterMs }`. Callers map `!ok` to 429 with
 * `Retry-After: ceil(retryAfterMs / 1000)`.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
  reset(): void;
}

export interface RateLimiterOptions {
  /** Max requests allowed inside the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, number[]>();
  return {
    check(key, now = Date.now()) {
      const cutoff = now - opts.windowMs;
      const arr = (buckets.get(key) ?? []).filter((t) => t > cutoff);
      if (arr.length >= opts.max) {
        const oldest = arr[0] ?? now;
        const retryAfterMs = Math.max(0, oldest + opts.windowMs - now);
        buckets.set(key, arr);
        return { ok: false, remaining: 0, retryAfterMs };
      }
      arr.push(now);
      buckets.set(key, arr);
      return { ok: true, remaining: opts.max - arr.length, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * CSRF guard for cookie-authenticated mutating routes (WP8).
 * Returns true when the request's Origin matches the app origin (or is absent
 * for same-origin navigations that send no Origin). Callers return 403 on false.
 */
export function isSameOrigin(req: Request, appOrigin: string): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Some same-origin requests omit Origin; fall back to Referer host.
    const referer = req.headers.get("referer");
    if (!referer) return true;
    try {
      return new URL(referer).origin === appOrigin;
    } catch {
      return false;
    }
  }
  return origin === appOrigin;
}
