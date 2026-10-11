# ADR-0012 — M8 task C2a: `POST /ingest/traces`

Date: 2026-10-11 · Status: accepted

## Context
Plan §10.1: workers send batches of verified traces. The M7 importer already knows how to turn a trace
into rows, but it is a Postgres-only local script (it takes a raw Drizzle `Db`), so an HTTP endpoint that must also
work against the in-memory store cannot call it. Reading it also turned up two tenant-scoping bugs (below).

## Decisions
1. **Reuse the importer's parser, not its writer.** `prepareTrace` feeds `parseTraceLine` (so turn status, thought
   extraction, tool-call counting and `n_tool_calls` are interpreted exactly as for a JSONL file) and writes through a new
   org-scoped repo method, `ingestTrace`, implemented on both stores.
2. **Identity, not content hash, decides duplicates** (ADR-0008): `(dataset, image, cohort, mode)`. An existing identity
   is never overwritten (first import wins). Unlike the importer, which lumps everything into "deduped", the result says
   `existing` plus `sameContent` (does the stored content hash equal this one?), so a worker can tell an idempotent retry
   from a trace that changed.
3. **Content hash over a canonical line:** sorted keys, no whitespace, with `messages` (the large chat transcript) and `image_path`
   (machine-specific) replaced by constants. Both are optional in the request and never persisted, so including them, omitting
   them or re-ordering keys cannot change identity. Consequence: a trace imported from a file is hashed over its raw line,
   so re-sending the same trace over HTTP reports `existing` with `sameContent: false` even though nothing meaningful changed.
   Identity still dedupes it correctly; only the `sameContent` hint differs across the two paths.
4. **Per-item outcomes in a 200.** Structurally invalid requests are a 422 (client bug). State-dependent results are data:
   `inserted`, `existing`, or `rejected` with `unknown_dataset | unknown_image | invalid_trace`. One bad trace never blocks the
   rest; a retried batch is safe. Each trace commits atomically with its turns and tool calls (own transaction).
5. **Nothing is created implicitly.** The dataset (by `source`: `dentex`, `tufts`, `upload`) and the image (by its dataset image
   number) must already exist in the caller's organization, otherwise `rejected`. Creating datasets would mean inventing licence
   notes (Tufts terms are unconfirmed, plan §12.4), and creating placeholder images would hide missing data.
6. **Tenant safety is enforced in the repo, not trusted from the handler:** dataset and image are resolved inside the
   org-scoped call (foreign keys alone would let a tenant attach a trace to another tenant's image).
7. **Data-quality guard:** a repeated turn number is `invalid_trace` (it is the storage key); the in-memory store throws on it,
   like the unique indexes do in Postgres.
8. **Limits:** 100 traces per request, 1 MB body (413 beyond). Workers should omit `messages`. Scope: `jobs:write`.
9. **Cohort** is a slug (`[a-z0-9_]`, up to 64 chars); the importer's `hybrid` union label is refused.

## Importer findings (fixed in this change)
- `insertEvalRows` looked up an existing run by `source_file` across **all organizations**: a second org importing the same file
  was told "already imported" and silently got no run. Now scoped by org. Reproduced on the original code (org B: `evalRunsExisting: 1`).
- `insertTraceRows` loaded every tenant's traces into memory to build its identity map. Now scoped by org.
- The importer's DB writer had **no database-level tests** (only parsing). `tests/m8-importer-scoping.test.ts` adds two (Postgres).

## Not in this change
`POST /ingest/eval-run` stays 501 (task C2b). It needs decisions the plan does not make: eval cases have no repo layer and no natural key
(`eval_cases` has no source image id, so a retried batch cannot be deduplicated), a whole real run may not fit the 1 MB
(Vercel: 4.5 MB) body, and the stored `summary` must stay computed from all stored cases (plan §0 rule 3), which a chunked upload makes
a recompute rather than a one-shot. Expect a migration.

## Verification
`tests/m8-ingest-traces.test.ts` (38: pure, repo and HTTP, on memory and Postgres, `CI=1`), inputs are the repo's sanitized real-shaped
fixtures. Mutation-checked (9): org filter on the dataset lookup, identity ignoring mode, hash including messages, `sameContent` always
true, ownership check on turn reads, unsorted canonical JSON, read-only token accepted, duplicate-turn guards in the preparer and in the
memory store. `pnpm e2e:worker` posts a real fixture trace over HTTP and counts the rows, turns and tool calls in Postgres (once, not doubled
by the replay).

## Not verified
Real VLM-DENTAL trace files (only the sanitized fixtures); request sizes near the 1 MB cap with realistic `messages`; concurrent
identical batches (the `ON CONFLICT DO NOTHING` + re-read is reasoned, not load-tested); Postgres 17 / Actions / Vercel.
