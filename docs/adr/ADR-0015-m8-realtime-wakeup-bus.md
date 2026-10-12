# ADR-0015 — M8 task D: optional Redis wake-up bus for SSE and worker long-polls

Date: 2026-10-12 · Status: accepted

## Context
SSE streams and worker long-polls waited on a fixed database poll (800 ms / 750 ms): up to a poll interval of latency, and one query per waiter per
interval even when nothing happens. ADR-0009 deferred a Redis fan-out; the plan (§5.1) wants it optional with polling as the default and the fallback.

## Decisions
1. **The bus carries hints, never data.** A message means "this job / this org's queue changed, read the database now". Postgres stays the source of truth, so a lost,
   duplicated or late message cannot lose or duplicate an event (the next read returns exactly what is stored, in order, resumable via `Last-Event-ID`). A dead bus costs latency only.
2. **Waiters subscribe before their first database read**, so a change in between yields a hint (the next wait returns at once) and a change before it is seen by the read itself.
   A hint that arrives while the waiter is busy is remembered, not dropped.
3. **Polling becomes a safety net, not the mechanism.** While the bus is live and healthy a waiter polls every `max(pollMs, 5 s)`; if the bus is absent, refused, or reports itself
   unhealthy (a Redis outage) it goes back to the short interval immediately. A hung or failing bus can delay a write by at most 300 ms (`safePublish`) and never fails it.
4. **Channels:** `tf:job:<jobId>` (SSE watchers) and `tf:queue:<orgId>` (parked `jobs/claim` long-polls). Published after: claim, event append, complete, fail (also wakes the queue:
   the job may be retried), user create (wakes the queue), user cancel. Names embed ids that are unguessable and the payload is empty; an SSE route still does its org-scoped `getJob` first,
   so a foreign job id is a 404 before anything subscribes.
5. **Transport: Redis protocol over TCP/TLS (`REDIS_URL`), core `@redis/client` only** (6.2.1, chosen for being older than two weeks; the `redis` meta-package would have added four unused modules).
   This **replaces** the plan's `UPSTASH_REDIS_REST_URL/TOKEN`, which nothing ever read. Reason: waiting for a message needs a persistent subscription, and the only transport I could verify
   against a real server here is the Redis protocol. Upstash exposes a `rediss://` endpoint too, so the vendor choice is unchanged; the REST client is not implemented. `capabilities.redis`,
   `/api/health` (`absent | up | down`) and `/status` now report the real state, not just "variable present".
6. **RESP2 is pinned.** `@redis/client` 6.x defaults to RESP3 and then sends `HELLO 3` on every connect; Redis < 6 does not know `HELLO`, so every command fails and the bus looks permanently
   down. This was found by the owner's local agent on a Windows Redis 5.0 build (the first version of this ADR claimed the protocol worked on any Redis; that was untested for Redis < 6).
   Pub/sub, `PUBLISH` and `PING` need nothing from RESP3, so the bus always speaks RESP2, which every Redis version accepts. One code path everywhere: no environment switch, and no case where production
   speaks a protocol the tests did not.
7. **Two connections per process** (one publishes, one holds every subscription, multiplexed: one `SUBSCRIBE` per channel however many local waiters). Commands fail fast when
   disconnected, reconnection is automatic with capped backoff (250 ms → 15 s, never gives up), and the client restores subscriptions after a reconnect (verified with a real kill and restart).
8. **`MemoryBus`** (in-process) implements the same interface and is the deterministic test double; it is not selectable by configuration.
9. **Serverless note (not verified on Vercel):** a stream holds one TCP subscription per function instance for its lifetime (`maxMs` 45 s, then `reconnect`). Many concurrent instances means many
   connections; Upstash's connection limits are the thing to watch.

## Consequences
- With no `REDIS_URL` (the default) nothing changes: the 435 pre-existing tests pass untouched.
- `.env.example`, the plan's env table and `capabilities.redis` changed to `REDIS_URL`. A deployment that had set the old `UPSTASH_*` variables gets polling until `REDIS_URL` is set.
- CI installs `redis-server` and runs the transport suite and the e2e with the bus on (unverified: I cannot run GitHub Actions).

## Verification
`tests/m8-bus.test.ts` (39; memory and Postgres stores): helpers, then the real handlers with a `sleep` that NEVER resolves, so only a hint can wake a stream or a long-poll, with control runs that stay
parked without one; dead, lossy (drops every hint) and hung buses; subscription release; tenancy. 11 mutations (each publish, the wake, the bound, the dirty flag, the release, the safety interval) all fail it.
`tests/m8-bus-redis.test.ts` (9, real `redis-server` 7.0, `CI=1` fails if absent): cross-instance delivery, channel isolation, one shared server-side subscription released with the last waiter
(`PUBSUB NUMSUB`), the full SSE path across two bus instances, every failure mode against a closed port, and a kill-and-restart of Redis (outage detected, `wake.live` flips, reconnects, original subscription
delivers again). 4 of 5 transport mutations fail it; the fifth (`disableOfflineQueue: false`) is an **equivalent** mutation: the `ready()` gate already prevents commands while disconnected, so the option is
defense in depth I cannot claim is tested. `pnpm e2e:worker` with `E2E_REDIS_URL` runs the whole pipeline on the bus path and asserts that an open SSE stream sees a claim in 14 ms and a parked long-poll
returns a new job in 22 ms (limits 1500 ms); with the publishes removed the same checks take 4014 ms and 4630 ms (the safety poll), so they do discriminate.

## Verified on the owner's machine (reported by the owner's local agent, 2026-10-12)
Docker Redis for the transport suite (9 of 9 then, 11 of 11 after the fix below), the full suite (483 of 483), `pnpm build`, and `pnpm e2e:worker` with `E2E_REDIS_URL`: all checks passed, an open SSE stream
showed a claim in 46–58 ms and a parked long-poll returned in 46–47 ms (against the 5 s safety poll). On the Windows Redis 5.0 binary the kill-and-restart test first failed twice: the Windows port rejects
`--save ""` as a command-line flag (the test now starts Redis from a config file, which is portable), and then the `HELLO` handshake (decision 6). The agent worked around the second by adding a RESP switch;
that change was NOT adopted: it left production on RESP3 and made only the tests protocol-aware. Instead RESP2 is pinned for everyone, and the old-server behaviour is covered by
`tests/m8-bus-redis.test.ts` against `tests/helpers/legacy-redis.ts`, a small RESP2 server that rejects `HELLO` like Redis 5 does (it models the handshake only; it is not a Redis). One test shows the premise (the
client's default protocol cannot connect to it), one shows the bus can; removing the pin fails exactly that one. A real Redis 5.0 was run by the agent only, not by the author of this ADR.

## Not verified
Upstash itself (TLS, auth, connection limits, latency from Vercel); behaviour under many concurrent streams; Redis Cluster / pub-sub sharding; GitHub Actions; the unverified claim in decision 9.
