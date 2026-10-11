# ADR-0011 — M8 task C1: `models/register` and `ingest/metrics`

Date: 2026-10-11 · Status: accepted

## Context
Plan §10.1 lists `POST /models/register` and `POST /ingest/metrics`. The tables existed
(`model_registry`, `training_runs`, `training_metrics`, `reward_samples`) but nothing wrote to them,
and the plan's body for `ingest/metrics` (`{runId, step, name, value}[]`) assumes a `runId` that no
endpoint, UI or importer ever creates. These two endpoints are the first half of task C; `ingest/traces`
and `ingest/eval-run` (which need the M7 importer's dedupe) are C2.

## Decisions
1. **The run is declared inline and identified by `(kind, name)`** instead of a pre-existing `runId`.
   A worker that survives a Colab restart knows its run *name*, not a server-generated id; the response returns
   the `runId`. This deviates from the plan's literal body and needs a unique index (`training_runs_org_kind_name_uniq`).
2. **Idempotency by natural keys, not an `Idempotency-Key` header:** runs by `(org, kind, name)`, metrics by
   the existing primary key `(run, step, name)`, reward samples by a new unique index `(run, step, trajectory_ref)`
   (migration `0003`). Re-sending a batch overwrites the same keys with the same values; the response says how many rows were
   `inserted` (new) out of `received`. These two endpoints do not use the plan's generic `Idempotency-Key` header (job creation does): the keys above already make them safe to retry.
3. **Duplicate keys inside one batch are rejected with 422** (naming both positions) rather than "last wins":
   which value wins would otherwise depend on the store, and Postgres refuses such an upsert outright.
4. **One transaction per request:** run upsert + metrics + reward samples succeed or fail together. A rejected
   batch leaves no run behind. The run row is created with `ON CONFLICT DO NOTHING` and re-read `FOR UPDATE`, so two sessions
   racing on the same run cannot corrupt the status merge.
5. **Run status only moves forward** (`queued → running → succeeded|failed`; terminal is final). New runs start `running`.
   A late retry from a dead session therefore cannot reopen a finished run; the response carries the status actually stored.
6. **"Omitted = keep" for optional fields** (`hfPath`, `meta`, `onnxArtifactId`, run `config`): a retry that
   lacks the ONNX export must not erase it. Provided `meta`/`config` replace the stored value wholesale (no deep merge).
7. **Model validation:** `kind "yolo"` and `stage "yolo"` go together. `onnxArtifactId` must be a `model` artifact of the
   caller's org; another org's artifact reads as "missing".
8. **Float32 is part of the contract.** `training_metrics.value` and `reward_samples.total` are Postgres `real`. Values are
   validated to fit a float32 (otherwise the INSERT would overflow) and the in-memory store rounds exactly as Postgres
   returns them (shortest round-tripping decimal), so both stores read back identically. Reward `components` are `jsonb`
   (full double precision).
9. **Limits:** 5 000 metric points and 500 reward samples per request (the body cap is 1 MB); inserts are chunked at
   1 000 rows. Scope required: `jobs:write`; a `jobs:read` token gets 403.

## Consequences
- Migration `0003` adds two unique indexes. Existing databases are unaffected only because nothing wrote to these tables
  before; a database that somehow holds duplicates would need them cleaned first.
- Nothing in the UI reads these tables yet (Training Hub, M12); the repo has `listModels`, `listTrainingRuns`,
  `listTrainingMetrics`, `listRewardSamples` ready for it.
- No audit log entry is written for worker-initiated writes (a worker token has no acting user).
- Mid-request database failures still surface as 500 (as in the existing handlers); only "database unreachable at
  request start" is a 503. Worth a separate hardening pass for all worker endpoints.

## Verification
`tests/m8-ingest-repo.test.ts` (24) and `tests/m8-ingest-api.test.ts` (26) run on the memory store **and** Postgres (CI fails
if Postgres is absent). `pnpm e2e:worker` drives both endpoints over real HTTP against the production build and reads the persisted
rows back from Postgres. Mutation-checked: dropping the ONNX-kind check, letting terminal status change, removing the org filter on
metric reads, wiping `hfPath` on re-register, accepting read-only tokens, replacing the metric upsert with DO NOTHING, skipping float32
rounding in memory, and removing the in-batch duplicate check each fail the suites. The migration chain `0000→0003` was applied to a
scratch database and `drizzle-kit generate` reports no drift.

## Not verified
Concurrent writers to the same run (the lock is reasoned, not load-tested; k6 is on the M8 backlog), Postgres 17 / GitHub Actions /
Vercel (sandbox is Postgres 16), and a real VLM-DENTAL worker calling these endpoints (the Python reference worker does not use them yet).
