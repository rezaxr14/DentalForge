# ADR-0007: Production secrets guard and CI-strict Postgres tests

**Date:** 2026-10-08
**Status:** Accepted (Claude review follow-up)

## Context

`src/shared/config/env.ts` shipped with hard-coded defaults for
`BETTER_AUTH_SECRET`, `INVITE_SIGNING_SECRET` and `DATABASE_URL`. The repo is
public, so in production those defaults are *publicly known secrets*: a deploy
that forgot to set them would run with forgeable sessions and invite
signatures. Additionally `capabilities().db` was derived from
`DATABASE_URL.length > 0`, which the default URL satisfies unconditionally —
the capability detected nothing. Finally, the Postgres integration suites
(`tests/m6-auth.test.ts`, `tests/m6-repos.test.ts`) skipped silently whenever
the database was unreachable, so a broken CI service could drop
cross-tenant/auth coverage without failing the pipeline.

## Decision

1. **Fail at startup in production.** When `NODE_ENV=production`, `parseEnv`
   requires `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`
   (≥ 32 chars) and `INVITE_SIGNING_SECRET` (≥ 16 chars) to be *explicitly*
   set, and rejects the `PUBLIC_KNOWN_SECRETS` set (the dev defaults plus the
   `.env.example` placeholders) even when set explicitly. All violations are
   aggregated into one thrown error. Development and test keep the friendly
   defaults; empty strings are treated as unset.
2. **Honest `capabilities().db`.** `AppEnv` gains `dbConfigured` (true only
   when `DATABASE_URL` came from the environment) and `capabilities().db`
   reads it. Reachability itself is still decided by the `selectOrgStore()`
   probe (memory fallback), per plan §9.
3. **CI must not skip Postgres suites.** Both DB-backed suites throw at
   module load when `process.env.CI` is set and the connection probe fails.
   Locally they keep skipping (the dev Docker database is optional).
4. **CI env provides build secrets.** `next build` runs with
   `NODE_ENV=production`, so `ci.yml` sets CI-only values for the three auth
   variables so the pipeline exercises the production path and stays green.

## Consequences

- A production deploy missing/weak secrets fails before serving traffic,
  with a message naming each missing variable (`tests/m6-platform.test.ts`
  locks the behaviour: missing, public-known, too-short, and valid cases).
- `.env.example` documents the guard and a secret-generation one-liner.
- `parseEnv` now throws for production misconfiguration, so anything calling
  `getEnv()` at import time (e.g. `shared/auth`) fails the whole process at
  startup — intended.
