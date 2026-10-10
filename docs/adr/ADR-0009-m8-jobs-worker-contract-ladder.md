# ADR-0009 — M8: job queue, worker contract v1, capability ladder, degradation

Date: 2026-10-10 · Status: accepted (M8 partially complete — see "Deferred")

## Context
Plan §9–§10: the app must deploy to Vercel with no Python backend and let the
owner attach a PyTorch worker later, from a home GPU behind NAT, Colab, Kaggle or
a cloud box. The commit before this one (`m8.1`) left typecheck failing, a
Drizzle store with none of the job methods, and memory semantics that ignored
lease ownership.

## Decisions
1. **Pull-based, outbound-only worker.** The worker polls `/api/worker/v1`; the app
   never calls it. Long-poll `claim` (≤ 20 s) over a DB poll (750 ms).
2. **Postgres is the queue.** `claimJobs` is one transaction using
   `FOR UPDATE SKIP LOCKED`; all lease math uses the **database clock** (`now()`),
   never the app clock, so serverless instances with skewed clocks agree.
3. **Lazy lease reaping, no cron** (Vercel Hobby cron is daily only). `reapJobs` runs
   inside claim, heartbeat, job reads and the SSE loop: expired lease → `queued`
   while attempts remain (max 3), else `expired`; queued > 7 days → `expired`.
4. **Heartbeat renews leases** (`renewLeases`) *before* reaping, so a live worker
   running a long job with no events is not reaped and re-run. Plan §10.1 asked for
   this; writing the docs exposed that the first implementation did not do it.
5. **Lease fence via `X-Worker-Id` (plan deviation).** The plan's `events`/`complete`/
   `fail` bodies carry no worker id, but ownership checks need one and tokens are
   per-org, not per-worker. Those endpoints now require an `X-Worker-Id` header
   naming a worker of the token's org. One shared `gateJobWrite()` implements the
   rules for both stores: `cancelled` / `terminal` / `not_owner` → 409 problem codes.
6. **Idempotency:** `events` on `(job, seq)`; `complete`/`fail` replay safely for the
   lease holder; `register` is an upsert by `(org, name)` (new unique index) so a
   restarted Colab session re-attaches to its own worker row; `POST /api/jobs`
   honours `Idempotency-Key`.
7. **Expected conditions are data.** Repo writes return `JobWrite<T>` results and
   handlers return RFC 9457 `problem+json` with stable `code`s; nothing throws for
   a cancelled/foreign/finished job.
8. **Framework-free handlers.** Every route is a one-liner over
   `(Request, deps) → Response`, so the full HTTP contract is tested with plain
   `Request` objects, on both stores.
9. **Capability ladder honesty.** `WORKER_MODE=mock` is no longer "always online"
   (that made jobs hang when no mock process existed). Status is derived from
   heartbeat age on read; `FEATURES` records what *this build* really has
   (browser ports, replay data) and must be edited in the same commit that ships a
   fallback. The ladder now reports `queueable`.
10. **Store selection hardened.** A failed DB probe is cached 15 s (was: forever, so
    one slow Neon cold start pinned a serverless instance to the in-memory store
    until redeploy); one shared `MemoryStore` survives re-probes; pool
    `connectionTimeoutMillis: 3000` so a blackholed host cannot hang requests.
11. **Better Auth is imported lazily** wherever it is not strictly needed
    (`deps.ts`, `resolve-source.ts`, settings page). It validates the env at
    *import* time, which made `/api/health`, every worker route and every
    fixture-backed page fail to load on a misconfigured deploy. Fail-closed is kept
    for anything that really needs auth; diagnostics and fixture pages now survive.
12. **Signed local storage gateway.** `/api/storage/[...key]` accepts only
    HMAC-signed, expiring, operation-bound URLs; PUT pins size + SHA-256; keys are
    tenant-prefixed; GET sets `nosniff` and a sandbox CSP.
13. **Docs are generated** from the zod schemas (`z.toJSONSchema`, no new
    dependency): `docs/worker-openapi.json` + `docs/worker-contract.md`; a test fails
    if they are stale or a worker route is undocumented.
14. **`system.ping`** job type added (not in plan §10.2): verifies the whole pipe
    with no GPU. Used by the status page and the e2e.

## Findings from testing (kept for the record)
- Postgres half of the shared repo suite caught nothing the memory half missed,
  which is the point: both implement one contract.
- The e2e caught the mock worker stringifying integer image ids; the server
  correctly answered 422 and the job failed non-retryably. Contract unchanged.
- The smoke test's misconfigured-env variant caught the eager-auth-import problem
  in (11).

## Deferred (documented, not hidden)
- **Redis/Upstash fan-out.** SSE reads `job_events` by DB polling; Redis is not used.
- **Endpoints answering 501** (documented in the contract): `models/register`,
  `ingest/eval-run`, `ingest/traces`, `ingest/metrics`.
- **Image variants:** `GET /images/:id` serves `original` only.
- **Worker-token admin UI** (settings); tokens are minted with `pnpm worker:token`.
- **Features do not consume the ladder yet.** `/status` and the header pill do;
  Tool Lab, LabelForge pre-label, trace viewer etc. still need `resolveFeature()` +
  provenance badges wired in.
- **Browser-level tests:** Playwright degradation/a11y specs are not written (the
  HTTP-level `pnpm smoke` and `pnpm e2e:worker` exist). k6 load tests, worker
  endpoint rate limiting, and an R2 adapter (still a stub) are also open.
- `trace.render_artifacts` has no handler in the mock or Python worker;
  `parity.golden` is not implemented.
- Artifact rows are created at presign time; uploads that never happen leave
  orphan rows (needs a janitor).
