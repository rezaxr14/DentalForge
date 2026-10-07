# ADR-0003: M3 quality-dashboard numbers count rows, not unique cases

**Status:** accepted
**Date:** 2026-10-05

## Context

`fixtures/goldens/m3_quality.json` scans 12 verified files = 5454 rows. Per
ADR-0001 the hybrid files are exact unions of per-cohort files (1645 unique
`(dataset, image_id)` in the with-tools split), so row totals over-count
unique cases ~2x. Statuses/tool calls are turn-level events, unaffected by
the caveat; per-file leak/reject/unparseable counts are exact per file.

## Decision

Dashboard shows row-level aggregates with an explicit dedupe note and a
per-file table. A future importer milestone will dedupe by
`(dataset, image_id, mode, cohort)` + content hash and recompute unique-case
stats in Postgres.

## Findings worth keeping

- ~~Directive leak is 100% systemic (every file, both modes, both datasets).~~
  **Withdrawn by ADR-0006:** that counted the teacher scaffold in stored user
  messages. Assistant-text leak under the real `LEAK_PATTERNS` definition is
  0/5,454; scaffold is present in 5,454/5,454 (expected generation setup).
- New status states vs M0 sample: `tool_all_failed` (75),
  `unparseable_recovery_attempt` (23), no-tools turns carry `<none>` (2727).
- Unknown tool names: `final_answer` as a tool call (74), `localize_tooth` /
  `localize` / `localize tooth 13` (4, all healthy_tufts).
- Healthy cohorts: zero false positives (all empty-GT traces end with `[]`).
- Perturb tiers observed 3978 small / 4597 big (46/54 of perturbed calls;
  plan §4.3's 45/25/30 split is over all calls incl. unperturbed).
