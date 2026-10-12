# ADR-0014 — The eval contract meets real model output; the importer may not skip silently

Date: 2026-10-11 · Status: accepted

## Context
While verifying `ingest/eval-run` on the owner's real files, the owner's local agent reported (the author of this ADR has not seen the data)
that **12 of 49 lines** of `zero_shot_dentex_test_transformers_Qwen--Qwen3.5-9B.jsonl` fail `EvalCase`:
a prediction's `tooth_position` holds a whole FDI code (18, 28, 36 … 48) although `Finding` caps it at 8, and some `confidence` values are `null`
where the schema wanted a number or nothing. The two paths then disagreed: the **importer skipped the 12 lines silently** (n=37, so every mean in the
run summary is over a biased subset, and nothing said so) while **`ingest/eval-run` rejected the whole chunk**. M0's rule applies: *reality wins; update the
zod schemas, not the data.*

## Decisions
1. **Model output gets its own, tolerant finding type.** `PredictedFinding` = `Finding` with any integer `tooth_position` and a nullable `confidence`. It is used
   for `EvalCase.predictions` and `MatchedPair.pred`. A model that writes "36" where a position belongs is exactly what the eval metrics score; the record that stores
   the mistake must be able to represent it.
2. **Ground truth stays strict** (`Finding`: position 1–8, quadrant 1–4; `MatchedPair.gt`): it comes from the dataset, so a violation is a data error worth refusing.
   Predictions keep their other constraints too (integer position, quadrant 1–4, confidence 0–1 when present, required fields).
3. **`EvalCase.confidence` is `nullish`** (real files contain `null`).
4. **Traces are unchanged.** The M7 gate (3,694 of 3,694 trace lines import) shows they already validate; this change is evidence-driven, not a general loosening.
5. **The importer reports what it skips.** `parseEvalFileDetailed` returns the non-blank line count, the invalid count and the first 20 problems (1-based line, first 3 `path: message`).
   `import:local` prints per eval file `N lines, M valid[, K SKIPPED]` with the first reasons, and **fails its DoD gate** (exit 2) if any eval line was skipped.
   Skipping a bad line is still how a file imports (one bad line must not block the rest), but it can no longer be silent.
6. **Stale runs are detected and repairable.** A run imported before this change has fewer cases than its file now yields, and "existing run, skip" would keep it forever.
   `insertEvalRows` now counts such runs (`evalRunsStale`) and `import:local` fails its gate until they are replaced with `pnpm import:local --replace-evals`, which deletes only
   this organization's **file-imported** eval runs (`run_key IS NULL`) for the files being imported (cases cascade) and re-imports them in full. API-ingested runs and other tenants are never touched.
7. **`pnpm diagnose:data [dir]`** validates every real eval and trace line against the contracts and lists each failing path once, with how many lines it affects and one value
   *description* (`number 36`, `null`, `string(24)`, `missing`) — never string content from the data. One run shows every disagreement, not the first per line.
8. **`ingest/eval-run` keeps rejecting a structurally invalid chunk (422)**, now naming the case index and path (`cases.1.ground_truth.0.tooth_position`). Accepting a chunk
   partially would recreate the importer's problem under a different name: a summary computed over a silently reduced set.

## Consequences
- Any eval run already imported from the affected file is truncated in the owner's database (n=37). Re-running `import:local` alone does not fix it; `--replace-evals` does.
- The OpenAPI/contract docs change (predictions are looser); workers need no change and, for the reported file, no pre-filtering.
- `PredictedFinding.confidence` may be `null` where `Finding.confidence` could not, so code that reads a prediction's confidence must handle `null`. Today nothing reads a per-prediction
  confidence of an eval case; the one reader of the case-level value (`datasource.ts`) already guards `!= null`. (The trace page's `Finding.confidence` is a different, unchanged type.)

## Verification
`tests/m8-eval-real-data.test.ts` (17): the reported shapes are accepted; the previous contract demonstrably rejected them (a true reproduction); ground truth, integer-ness,
confidence range and quadrant are still enforced; skipped lines are counted, numbered and capped at 20 samples; the diagnosis counts per line, sorts by impact and cannot echo strings.
`tests/m8-ingest-eval.test.ts` (+3): the endpoint stores the quirks as emitted, importer and endpoint accept the same lines, a strict error is still a 422 naming its path.
`tests/m8-importer-scoping.test.ts` (+1, Postgres): a truncated run is reported STALE, the scoped replace repairs it and leaves another tenant's run (same row id) and an API-ingested run
untouched. Mutation-checked: 9 changes (predictions validated strictly again, lenient ground truth, lenient matched `gt`, uncounted invalid lines, string echo, per-issue counting, replace without
the org filter, replace without the API-run guard, stale detection off) each fail the tests.

## Verified on the owner's real data (reported by the owner's local agent, 2026-10-12)
`pnpm diagnose:data`: **all 20 real files validate**, including the 12 Qwen3.5-9B lines that failed before, so the two reported causes were the whole story. `pnpm import:local --replace-evals` exited 0 and
the Qwen file imported `49 lines, 49 valid` (it had been 37). Not re-run by the author of this ADR.

## Not verified
Whether an eval run already in a database OTHER than the owner's local one is truncated (the stale-run report and `--replace-evals` exist for exactly that).
