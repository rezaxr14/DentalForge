# ADR-0028: Public-site hardening (rate limit, R2, 503, body-size, CSRF, CSP, demo reset)

**Status:** accepted
**Date:** 2026-11-07
**Context:** This hardens the app for a public deployment. The primitives exist in
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

The policy and the other security headers live in **one place**, `src/shared/lib/csp.ts`, used by
`next.config.ts` (one rule, `/:path*`, which already covers `/api/...`) and by the API fallback in
`middleware/security.ts`.

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
```

- HSTS: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- Add `'wasm-unsafe-eval'`, a `worker-src` and a model `connect-src` only when the browser YOLO (ADR-0027) is built and needs them.

### Amendment 2026-11-09: `script-src 'self'` shipped and broke every page

The first version of this section specified `script-src 'self'` and said "axe and strict console unaffected;
report-only first". It was enforced without either. The Next.js App Router emits inline bootstrap scripts
(`self.__next_f.push(...)`), so the browser refused all of them ("Refused to execute inline script"), React threw
#412 and **no page hydrated** in a production build: static HTML with dead controls (editor, theme toggle, replay
controls). It was found by the browser suite (the strict console watcher and the hydration specs), not by review.

- **Decision:** keep `'unsafe-inline'` for scripts. A nonce-based policy (`'nonce-...' 'strict-dynamic'`) needs a
  proxy that forces dynamic rendering for every page; that trade-off is a separate decision, not a quick fix. The
  rest of the policy stays closed (same origin, no framing, no plugins, no foreign form targets, no `<base>`).
- zod 4 probes `Function("")` once to decide on JIT compilation; under this policy the probe is a (caught)
  violation on every page that parses. In the browser zod is configured `jitless` (`src/shared/lib/zod-browser.ts`,
  applied by `BrowserRuntime` in the root layout); the server keeps the JIT. `'unsafe-eval'` is **not** allowed.
- **Tests:** `tests/csp.test.ts` (policy text, single definition) and `e2e/security-headers.spec.ts` (six pages: headers,
  zero `securitypolicyviolation` events, strict console; the editor leaves its connecting phase, which needs
  hydration; the API response carries the policy once). Negative controls: with `script-src 'self'` 7 of 8 fail;
  without `BrowserRuntime` `/labels/1` fails with `script-src eval`.

### Amendment 2026-11-14: browser YOLO needs WebAssembly

The browser pre-label tier (ADR-0027) compiles the ONNX graph with `WebAssembly.instantiate`. Chromium refuses
that under the policy above ("Refused to compile or instantiate WebAssembly module"), so the policy gained exactly
two things and nothing else:

```
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';
worker-src 'self';
```

- `'wasm-unsafe-eval'` permits WebAssembly compilation only; `eval` and `new Function` remain blocked (zod stays
  `jitless`). `'unsafe-eval'` is still absent.
- `worker-src 'self'`: the worker bundle and the ORT runtime are same-origin files under `/models/yolo/`.
  `connect-src 'self'` is unchanged because the 49.5 MiB model is served from this site, not a CDN.
- **Tests:** `tests/csp.test.ts` pins both tokens and the absence of `'unsafe-eval'`;
  `e2e/browser-yolo.spec.ts` downloads, instantiates and runs the graph in a real Chromium with no CSP violation;
  `e2e/security-headers.spec.ts` still sees zero `securitypolicyviolation` events on six pages.

## Demo org policy

- Demo invite link grants role `annotator`
- Per-user caps (already enforced): ≤ 5 sets, ≤ 500 boxes per set, ≤ 200 ops per request
- Job creation disabled for demo users (checked in `resolveUserDeps` → `actor.role === "annotator" && org.isDemo`)
- Self-review rule unchanged

### Nightly reset (`/api/demo/reset`)

`vercel.json` schedules `POST /api/demo/reset` at 03:00 UTC. Vercel sends
`Authorization: Bearer $CRON_SECRET` for a cron job when `CRON_SECRET` is set;
the route fails closed (401) when the secret is missing or wrong, and also
answers 429 through the standard rate-limit guard.

The route deletes what visitors created in the demo org — annotation sets,
annotations, review tasks and decisions, predictions, queue scores, agreement
stats, dataset exports, audit rows, invites, worker tokens, and the users whose
only membership is the demo org — and keeps the seeded rows (datasets, images,
traces, eval runs and cases, models, artifacts). A second run deletes nothing.
It does not re-seed; `pnpm demo:seed --reset` re-applies the committed bundle
when the data itself changes. Tested in `tests/demo-reset.test.ts` (auth
negative, seeded rows survive, second run is a no-op).

## Worker tokens (ADR-0010)

- Scopes: `claim`, `events`, `artifacts`, `ingest` — each with a negative test
  (token without scope → 403)
- Tokens hashed at rest (bcrypt, verify on use)
- Revoke works; a token for org A cannot touch org B jobs, traces, artifacts

## Hygiene

- `pnpm audit` and a secret scan are **not** wired into CI. The only automated
  leak guard is the demo-bundle test suite (`tests/python/test_demo_build.py`),
  which scans `demo/` and `public/demo-assets/` for key patterns, personal paths
  and Tufts markers. A repository-wide secret scan is still open work.

## Acceptance

- All wired routes return 429 with `Retry-After` on burst
- R2 adapter: **not implemented**; live-worker artifact upload works only with
  the local filesystem adapter, which is ephemeral on Vercel
- DB failure mid-handler → 503 + `Retry-After` (regression test)
- Body-size enforcement → 413 on oversize streaming payload
- CSRF → 403 on cross-origin mutating request
- CSP headers present; axe + strict console pass
- `/api/demo/reset` with valid `CRON_SECRET` clears visitor rows and keeps the
  seeded data; invalid secret → 401 (`tests/demo-reset.test.ts`)
- Worker token scope negative tests pass
- `pnpm audit` and a repository-wide secret scan: **not done**