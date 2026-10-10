# ADR-0010 — M8 task B: worker-token administration in `/settings`

Date: 2026-10-10 · Status: accepted

## Context
ADR-0009 deferred a UI for worker tokens; they could only be minted with
`pnpm worker:token`. Admins need to create, see and revoke tokens without shell
access to the database, and every such change must be attributable.

## Decisions
1. **Framework-free core** (`src/shared/jobs/token-admin.ts`): `createTokenForAdmin`,
   `listTokensForAdmin`, `revokeTokenForAdmin` take `(store, actorId, orgId, …)`, return
   Result-shaped data (`forbidden | invalid-input | not_found | limit_reached | offline`) and
   never throw for expected conditions. The `"use server"` file is a thin session → store → core
   wrapper, like `invite-actions.ts`. Browser-safe constants/types live in `token-types.ts`
   (no `node:crypto`), because the settings client component imports them.
2. **Authorization:** two new admin-only actions, `worker.createToken` and `worker.listTokens`,
   next to the existing `worker.revokeToken` (instead of the single `worker.manage` the handoff
   suggested: the repo's actions are verb-granular and `can()` has exhaustive tests).
   Non-members and under-privileged members get the same `forbidden`; a token id from another org is
   `not_found`, indistinguishable from a missing one.
3. **Secrets:** the raw token is returned once, by create. It is never listed, audited or stored
   (only its SHA-256, as before). The summary type deliberately has no `tokenHash`.
4. **Audit:** `worker.token.create` / `worker.token.revoke` with `{name, scope}` metadata. Failure
   directions differ on purpose: if the audit write fails on **create**, the token is revoked again and
   nothing is handed out (a privileged change we cannot attribute must not exist); on **revoke**
   the revocation stands (the safe direction is never undone by a logging failure).
5. **Least privilege in the UI:** only `jobs:write` (default) and `jobs:read` are offered.
   `admin` scope stays CLI-only: no worker endpoint requires more than `jobs:write` today
   (`worker-handlers.ts`), so granting it would add risk without capability.
6. **Cap:** at most 20 active tokens per org (`MAX_ACTIVE_TOKENS`); revoking frees a slot. The
   check is not transactional, so a concurrent burst could overshoot by a few; acceptable for an
   admin-only, human-paced action.
7. **Refuses the in-memory fallback store:** tokens minted into it would vanish on restart and
   could never authenticate against the real database, so the action answers `offline`.

## Verification
`tests/m8-token-admin.test.ts` runs one suite against the memory store **and** Postgres (fails
in CI if Postgres is absent): role matrix, cross-tenant isolation, hash-only storage, audit rows,
validation, cap, both audit-failure directions, outage-as-data. Mutation-checked: leaking the token
into audit meta, dropping the role check, dropping the cap, skipping the org lookup and not
retiring a half-created token each make the suite fail. `tests/m8-token-ui.test.tsx` pins the
server-rendered first paint.

## Not verified
Interaction in a real browser (copy button, two-step revoke, one-time reveal, focus handling) and
an axe pass: Playwright is task E. The server actions are exercised through the core, not through
Next's action transport.
