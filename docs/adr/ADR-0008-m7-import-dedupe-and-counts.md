# ADR-0008: M7 Importer Deduplication, Image Counts, and DataSource Switch

**Date:** 2026-10-09
**Status:** Accepted

## Context

Milestone M7 implements the local importer (`pnpm import:local`) and interchangeable `DataSource` abstraction (plan §4.3, §7, §13). During validation of the importer against the real VLM-DENTAL source corpus (`data/traces/*.jsonl` and `data/evaluations/*.jsonl`), four realities differed from the draft plan assumptions:

1. **Global `content_hash` unique constraint:** Plan §7 proposed `uniqueIndex("traces_content_uniq").on(t.contentHash)`. However:
   - 11 cross-cohort trace lines are byte-identical across cohorts but represent distinct identities; a global unique index dropped them, preventing the corpus from reaching the DoD's target of 3,694 traces.
   - A global unique index would violate multi-tenancy isolation (an import in Org B would fail if Org A already imported the row).
2. **Hybrid union files:** `train_cot_traces.jsonl` and `train_cot_traces_no_tools.jsonl` are byte-identical unions of the 5 per-cohort files. Processing both caused unnecessary duplication and obscured cohort attribution.
3. **Image count definition:** Plan §4.2 listed 1,847 images across 5 cohorts (678 + 27 + 202 + 660 + 280). However, 1,847 counts cohort *memberships*. The 202 Tufts overlap images are a subset of the 280/660 Tufts cohorts. Across unique `(dataset_id, source_image_id)` pairs, there are 705 DENTEX images and 940 Tufts images, totaling exactly 1,645 unique images on disk.
4. **Schema quirk in real traces:** 4 lines in the per-cohort trace files contain a `{thought, final_answer}` object in the `parsed.tool_calls` array instead of `{tool, args}` (the model emitted its final answer in the tool call slot). Strict validation failed these lines.

## Decisions

1. **Identity-scoped uniqueness for traces:**
   - Drop `traces_content_uniq` (migration `0001_light_mephistopheles.sql`).
   - Retain the composite identity index: `uniqueIndex("traces_unique_uniq").on(t.datasetId, t.imageId, t.cohort, t.mode)`.
   - Add a non-unique index `traces_content_idx` on `content_hash` for fast lookup and audit.
2. **Prioritized file ingest and hybrid skip:**
   - Assign priority 0 to per-cohort files, priority 1 to any other specific cohort files, and priority 2 to hybrid union files (`train_cot_traces{,_no_tools}.jsonl`).
   - The importer skips priority 2 files completely. The 10 per-cohort files yield exactly 3,694 traces (1,847 with_tools + 1,847 no_tools) with 0 duplicates.
3. **Accept 1,645 unique images as the ground truth:**
   - The DoD count gate checks for ≥ 1,645 unique images and 3,694 trace rows.
4. **Tolerant `ParsedToolCall` schema:**
   - Make `tool` and `args` optional in `ParsedToolCall` in `src/shared/contracts/traces.ts` (plan §0 rule 2: reality wins). Tool calls without a `tool` name are ignored during turn processing rather than failing the entire trace.
5. **DataSource resolution with graceful fallback:**
   - Introduce `resolveDataSource()` in `src/shared/lib/resolve-source.ts`.
   - Default to `fixtureSource()` unless `TRACEFORGE_DATASOURCE=postgres`.
   - If Postgres is configured but unreachable or unauthenticated, fall back to `fixtureSource()` with an explicit `fallbackReason`.
   - Attach `provenance: "fixture" | "postgres"` to list and detail rows, rendered as a badge in the UI.

## Consequences

- `pnpm import:local --dry-run` and live import report exact, deterministic counts matching reality: 1,645 images, 3,694 traces, 8 eval runs.
- Multi-tenant imports into different orgs do not collide on global hashes.
- The UI gracefully indicates data provenance without crashing when Postgres is offline.
