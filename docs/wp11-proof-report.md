# WP11: End-to-end proof report

**Date:** 2026-11-07
**Commit:** (fill at PR time)
**Status:** Draft — fill in commands and exit codes after running

Each proof has a negative control (the check must fail when the thing it protects
is removed). Report each as PASS/FAIL with the command and real exit code.

| # | Proof | Command | Exit | Negative control | Neg. exit | Status |
|---|-------|---------|------|------------------|-----------|--------|
| P1 | Contract validated on both sides: Python events/results against `docs/worker-openapi.json`; Zod parser on recorded real worker output, for every job type | `pnpm contract:validate` (Python side) + `pnpm test -- contracts` (Zod side) | | Invalid event fails both validators | | NOT RUN |
| P2 | Token scopes and tenancy: each scope has a denied case; token of org A cannot read/write org B jobs/traces/artifacts; revoked token gets 401 | `pnpm test -- m8-ingest-traces` (scope tests) + manual cross-org test | | Remove scope check → test fails | | NOT RUN |
| P3 | Size limits and failure modes: oversize payload 413; event flood limited; malformed model output tolerated (`formatOk=false`); worker killed mid-job (lease expiry, UI shows it); app unreachable (worker backs off, buffers, no dupes); database down (503 + Retry-After) | `pnpm test -- m8-rate-limit` + `pnpm e2e:worker` (failure injection) | | Each failure injected, behaviour asserted | | NOT RUN |
| P4 | Real round trip: real trace per cohort + trace 255 imported, stored, exported, deep-equal modulo derived fields | `pnpm demo:build && pnpm demo:seed --reset && pnpm test -- m8-ingest-traces` | | Corrupt one stored field → comparison fails | | NOT RUN |
| P5 | Real live run: LM Studio test backend `agent.run` on `val_18` stored and viewable with tool images; `torch_hf` smoke on 9B only after owner's yes | `.\scripts\start-worker.ps1` then queue run on `/agent` for case `val_18` | | Stop LM Studio → job fails retryable with reason | | NOT RUN |
| P6 | Degradation matrix: worker alive/dead × DB up/down × storage up/down; each feature shows right rung/label; strict console clean | `pnpm e2e:browser` (5 variants × all pages) | | Break one dependency → expected message appears | | NOT RUN |
| P7 | Secure by default: worker opens **no listening socket** (static check for server frameworks + `bind`, runtime check `Get-NetTCPConnection -State Listen -OwningProcess <pid>` empty); tokens hashed at rest; no secret in bundle (canary) | `pnpm test -- m7-importer` (canary) + manual socket check | | Add listener in test double → check fails | | NOT RUN |
| P8 | Upstream drift drill: rename a required function in a copy of `dental_agent`, run the probe, show capability change reaches app and UI falls to next rung | Manual: copy VLM-DENTAL, rename `agent.run` → `agent.run2`, run probe | | Restore name → capability returns | | NOT RUN |

## Gate runs (Windows)

| Gate | Command | Passed | Total | Exit |
|------|---------|--------|-------|------|
| Typecheck | `pnpm typecheck` | | | |
| Lint | `pnpm lint` | | | |
| Unit tests | `pnpm test` | | | |
| Browser e2e | `pnpm e2e:browser` | | | |
| Worker e2e | `pnpm e2e:worker` | | | |
| Pytest | `pytest` (if applicable) | | | |

## Notes

- All proofs must be run and recorded with real exit codes before WP11 is complete
- Negative controls are required for each proof — a proof without a negative
  control is NOT RUN
- `torch_hf` smoke on the 9B model is NOT RUN (heavy-run gate; owner has not
  approved). Record that it was not run.