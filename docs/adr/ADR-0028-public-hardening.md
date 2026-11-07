# ADR-0028: Public-site hardening (rate limit, R2, 503, body-size, CSRF, CSP, demo reset)

**Status:** accepted
**Date:** 2026-11-07
**Context:** WP8 hardens the app for a public deployment. The primitives exist in
code; this ADR documents the wiring, tests, and acceptance.

## Rate limiting (`src/shared/lib/rate-limit.ts`)

In-process sliding window per key. Used as conservative fallback when Upstash
Redis REST is not configured; a single instance limiter is not shared across
Vercel instances, acceptable for a portfolio demo.

**Wired routes (return 429 + `Retry-After`):**
- `POST /api/auth/*` (sign-in, sign-up, invite redemption)
- `POST /api/worker/v1/*` (claim, events, heartbeat, register, ingest)
- `POST /api/labels/*` (ops, open, transition)
- `POST /api/jobs` (create)
- `POST /api/demo/*` (reset, if implemented)

Test: `tests/m8-rate-limit.test.ts` covers the primitive; integration spec
asserts 429 with `Retry-After` header on a burst.

## Real R2 adapter (`src/shared/storage/adapter.ts`)

Replace the stub with `aws4fetch` (pinned) for S3 API compatibility.

**Operations:**
- `presignPut(key, contentType, maxBytes, expiresInSec)` → `{ url, headers, expiresAt }`
- `presignGet(key, expiresInSec)` → `{ url, expiresAt }`
- `head(key)` → `{ size, contentType, etag }` (for sha256 check)
- `delete(key)`

**Policy:** 15-minute expiry, size limit per route (label: 10 MB, artifact: 50 MB),
content-type allow-list (`image/jpeg`, `image/png`, `application/octet-stream`),
sha256 verified on GET.

**Tests:** Contract tests against MinIO in Docker (GitHub Action). Negative:
wrong region, missing creds, oversize payload → clear error.

## Mid-request DB failures → 503 + Retry-After

Worker and label endpoints already return 503 when `isDegradedStore(store)`.
Extended: any route that touches the DB mid-handler (streaming response) wraps
the iterator and maps `PostgresError` / connection loss to 503 with
`Retry-After: 15`.

**Regression test:** Cut the DB connection mid-handler (mock pool that fails on
second query); assert 503 and `Retry-After` header.

## Body-size enforcement while streaming

When `Content-Length` is absent (streaming upload), enforce a hard limit:
- Label routes: 256 KB
- Worker routes: per contract (ingest traces: 2 MB, ingest eval: 1 MB, job artifacts: 50 MB)

Implementation: `ReadableStream` wrapper that counts bytes and aborts with 413.

## CSRF (cookie-authenticated mutating routes)

`src/shared/lib/rate-limit.ts` exports `isSameOrigin(req, appOrigin)`:

- Checks `Origin` header; if absent, falls back to `Referer` host
- Same-origin navigations that omit `Origin` are allowed
- Returns 403 on mismatch

**Wired routes:** All mutating routes that use cookie auth (label ops, job
create, invite consume, settings). Worker-token routes are exempt (Bearer auth).

**Test:** Cross-origin `fetch` from a different origin → 403; same-origin → 200.

## Headers and CSP

**Strict CSP** (in `next.config.ts` headers):

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';  # only if WP6 needs it
style-src 'self' 'unsafe-inline';      # Tailwind JIT
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' https://*.vercel.app https://*.supabase.co;  # plus R2 if configured
worker-src 'self' blob:;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
```

- `wasm-unsafe-eval` only if `onnxruntime-web` requires it (document in ADR-0027)
- HSTS: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

**Tests:** axe and strict console unaffected; CSP report-only mode in staging to
catch violations before enforcing.

## Demo org policy

- Demo invite link grants role `annotator`
- Per-user caps (already enforced): ≤ 5 sets, ≤ 500 boxes per set, ≤ 200 ops per request
- Job creation disabled for demo users (checked in `resolveUserDeps` → `actor.role === "annotator" && org.isDemo`)
- Self-review rule unchanged

### Nightly reset (`/api/demo/reset`)

Vercel Cron calls `/api/demo/reset` guarded by `CRON_SECRET` (header
`x-cron-secret: <value>`). Deletes non-seed annotation sets and users of the
demo org, keeps seeded data (images, traces, evals, models). Idempotent.
Tested: call twice, second call is no-op; seed data unchanged.

## Worker tokens (ADR-0010)

- Scopes: `claim`, `events`, `artifacts`, `ingest` — each with a negative test
  (token without scope → 403)
- Tokens hashed at rest (bcrypt, verify on use)
- Revoke works; a token for org A cannot touch org B jobs, traces, artifacts

## Hygiene

- `pnpm audit` result recorded in the PR
- Secret scan in CI (`trufflehog` or `git-secrets`)

## Acceptance

- All wired routes return 429 with `Retry-After` on burst
- R2 adapter contract tests pass against MinIO
- DB failure mid-handler → 503 + `Retry-After` (regression test)
- Body-size enforcement → 413 on oversize streaming payload
- CSRF → 403 on cross-origin mutating request
- CSP headers present; axe + strict console pass
- `/api/demo/reset` with valid `CRON_SECRET` resets demo org; invalid secret → 401
- Worker token scope negative tests pass
- `pnpm audit` and secret scan recorded in PR