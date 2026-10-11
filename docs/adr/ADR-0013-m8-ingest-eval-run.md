# ADR-0013 — M8 task C2b: `POST /ingest/eval-run`

Date: 2026-10-11 · Status: accepted

## Context
Plan §10.1: workers send "eval case rows + the run summary". Three things in the plan and schema did not fit that:
a real run may not fit one request (1 MB body cap here, 4.5 MB on Vercel); `eval_cases` had no natural key, so a retried
chunk could not be deduplicated; and the stored `summary` includes `spatial` and `diag_sim` means for which the cases
table had no columns, so it could not be recomputed from stored cases. The plan also says summaries are computed, never
hard-coded (§0 rule 3), and a worker-supplied summary would break that.

## Decisions
1. **A run is created by a worker-chosen `runKey`** (unique per organization) and filled in chunks of up to 100 cases per request.
   Dataset, split, provider and model are taken from the cases (they must agree within a chunk). On a later chunk
   they, and `canonicalResize`, must equal the stored run's, otherwise **409 `run_mismatch`** and nothing is written.
2. **Cases are upserted by (run, `image_id`)**: re-sending a chunk is harmless, and a re-sent image overwrites its case
   (latest wins). A repeated `image_id` inside one chunk is a 422 (it would make "which one wins" ambiguous).
3. **The server computes `n` and `summary`; the worker never sends them.** After every chunk both are recomputed from ALL stored cases
   of the run, with the same `summarizeEval` the importer uses (`parseEvalFile` was refactored onto it, so the two paths cannot
   drift; `evalCaseRow` is shared the same way). Chunked upload therefore equals one-shot upload (tested).
4. **Float32 caveat:** the metric columns are Postgres `real`, so the recomputed means are over 32-bit values and differ from a mean
   over the original doubles by about 1e-7. Both stores round identically, so they agree exactly with each other; against the importer
   path the tests assert agreement to 6 decimals.
5. **Schema (migration `0004`):** `eval_runs.run_key` with unique `(org_id, run_key)`; `eval_cases.source_image_id`,
   `spatial`, `diag_sim` with unique `(run_id, source_image_id)`. NULLs are distinct in Postgres, so file-imported rows
   (all NULL) are unaffected, and the importer is unchanged: it still does not fill these columns, and runs it created (no `run_key`)
   cannot be extended through the API. API runs get `source_file = "api:<runKey>"`.
6. **Same stored subset as the importer:** ground truth, predictions, matched pairs, three scores, the two new metrics,
   confidence, `format_ok`, raw output. Precision/recall, the correctness booleans, `finish_reason`, `final_answer` and
   `timestamp` are accepted but not stored, as before. `eval_cases.image_id` stays NULL (linked lazily).
7. **Concurrency:** the run row is locked (`FOR UPDATE`) for the whole transaction, so two chunks of one run serialize and each
   recompute sees every committed case. Cost: each chunk re-reads all of the run's cases, O(n), which is fine for hundreds.
8. **Scope:** `jobs:write`. All worker endpoints are now implemented; the `not_implemented` helper is kept for future ones.

## Fixed along the way
My C1 tests claimed cross-tenant coverage for the training-run lookup but never exercised the case that matters: the locked re-read after
an insert conflict, which only runs when the caller's own org already holds the key. Removing its org filter was undetected. Both C1
(`ingestTraining`) and this change now have a "same key in both orgs, each org's next chunk lands on its own run" test, and the mutation is caught.

## Verification
`tests/m8-ingest-eval.test.ts` (35: pure, repo, HTTP; memory and Postgres; `CI=1`) built from the real-shaped eval fixtures with
float32-unrepresentable metrics. Ten mutations checked (mismatch comparison, summary accumulated instead of recomputed, org filters, dropped
`canonicalResize`, float rounding, read-only token, dropped `spatial` mean, DO NOTHING instead of overwrite, in-chunk duplicate check); one
survived at first (the cross-tenant re-read) and led to the tests above. `pnpm e2e:worker` uploads a run in two chunks over HTTP, replays a chunk, provokes
the 409 and checks in Postgres that the stored summary equals the mean of the stored rows. Migrations `0000`→`0004` apply on a scratch database
and `drizzle-kit generate` shows no drift.

## Verified later on the owner's real data (reported by the owner's local agent, 2026-10-11)
Postgres 17 and the real VLM-DENTAL `data/evaluations` (8 files). Not re-run by the author of this ADR. Reported: no repeated `image_id`
in any file; one real 50-case run ingests in one chunk with a stored summary equal to the mean computed from the file (float32, 1e-6);
a 993,422-character chunk of real cases is accepted, the whole 1.77 MB file in one request is a 413 with no run written, and the remainder
completes the run; 2 rounds of 4 simultaneous chunks of one run all succeed and end with `n` equal to the stored rows and `summary`
equal to their mean (the row lock holds); migrations `0000`→`0004` apply to an empty database with no drift.
It also found the contract-vs-reality mismatch that led to ADR-0014 (12 of 49 lines of one real file were rejected).

## Still not verified
Postgres on Vercel/Neon and GitHub Actions.
