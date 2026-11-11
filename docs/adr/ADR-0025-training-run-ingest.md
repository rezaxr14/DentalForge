# ADR-0025: Training run ingest contract and schema

**Status:** accepted
**Date:** 2026-11-07
**Context:** The Training Hub page (`/training`) has a pipeline view
(Data → SFT → GRPO → Evaluation). Stages show "Done" only when real records
exist in the database; otherwise "Not run today". No target numbers in cells.
This ADR defines the minimal schema and ingest endpoint so the data flows when
runs exist.

## Schema additions (`src/shared/db/schema.ts`)

```ts
export const trainingRuns = pgTable("training_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // "sft" | "grpo"
  status: text("status").notNull(), // "running" | "succeeded" | "failed"
  baseModelId: uuid("base_model_id").references(() => modelRegistry.id, { onDelete: "set null" }),
  configJson: jsonb("config_json").notNull(), // full training config snapshot
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
});

export const trainingMetrics = pgTable("training_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => trainingRuns.id, { onDelete: "cascade" }),
  step: integer("step").notNull(),
  metricsJson: jsonb("metrics_json").notNull(), // { loss, lr, grad_norm, ... }
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rewardSamples = pgTable("reward_samples", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => trainingRuns.id, { onDelete: "cascade" }),
  sampleJson: jsonb("sample_json").notNull(), // { prompt, completion, reward_components, ... }
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});
```

## Ingest endpoint

```
POST /api/worker/v1/ingest/training-run
Authorization: Bearer <worker-token with scope "ingest">
Content-Type: application/json

{
  "kind": "sft" | "grpo",
  "baseModelId": "uuid",
  "config": { ... },           // full training config
  "metrics": [                 // per-step metrics
    { "step": 0, "loss": 2.1, "lr": 2e-5, ... },
    ...
  ],
  "rewardSamples": [           // optional, for GRPO
    { "prompt": "...", "completion": "...", "reward": { "accuracy": 0.8, ... } },
    ...
  ],
  "status": "succeeded" | "failed",
  "startedAt": "2026-11-07T12:00:00Z",
  "finishedAt": "2026-11-07T14:00:00Z"
}
```

Zod contract in `src/shared/contracts/ingest.ts` (add `TrainingRunIngestSchema`).
Worker token must have `ingest` scope (ADR-0010). Tenancy: `orgId` from token.

## Repositories

`OrgStore.ingestTraining(input: IngestTrainingInput): Promise<IngestTrainingResult>`
inserts the run, metrics, and reward samples in a transaction. Returns `{ runId, metricsInserted, samplesInserted }`.

`OrgStore.listTrainingRuns()`, `listTrainingMetrics(runId)`, `listRewardSamples(runId)`.

## UI contract

`/training` page reads:
- `listTrainingRuns()` for pipeline status
- `listModels()` for model table (kind badges: base/sft/grpo/test)
- `listEvalRuns()` for zero-shot leaderboard

SFT/GRPO cells stay "Not run yet" until a run with `status: "succeeded"` exists.
No synthetic data in production builds (test proves `ALLOW_SYNTHETIC_TRAINING=1`
is ignored when `NODE_ENV=production`).

## Negative control (test)

A test with `NODE_ENV=production` asserts that the synthetic loader is a no-op
and that `demo:seed` never writes a training run.