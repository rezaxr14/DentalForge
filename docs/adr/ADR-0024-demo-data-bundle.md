# ADR-0024: Demo data bundle — selection, build, seed, and provenance

**Status:** accepted
**Date:** 2026-11-07
**Context:** WP7 delivers a public-safe demo bundle sourced only from DENTEX data in
`../vlm-dental`. The bundle is the single source of truth for the deployed demo
and for local fixture fallback.

## Selection rules (deterministic, committed to `demo/selection.json`)

1. Up to 12 DENTEX images:
   - The 5 existing label fixtures (`1..5` in `public/labels/`)
   - Validation images with traces: `val_18`, `val_32`, `val_44`
   - Trace-255 image (`train_477.png`)
   - Up to 3 additional images that have traces in both cohorts
2. Up to 30 real traces on those images:
   - Always include trace 255 (with-tools, 23 turns, 66 tool calls, 15 artifact links)
   - With-tools / no-tools pairs where they exist
   - At least one failing or malformed trace so the UI shows honest failure
3. All 8 tracked zero-shot evaluation files + 10-model summary
4. The YOLO grounding tool's registry row with real `cv_results.json` metrics
5. The VLM-DENTAL config snapshot used for the bundle

Owner runs `pnpm demo:build -- --propose` to print the proposed selection, edits
`demo/selection.json` if needed, then runs `pnpm demo:build` to build.

## Build (`scripts/demo_build.py`)

Node orchestrator calls the Python CLI for artifact renders. Outputs:

- `demo/bundle.json` — sanitized images, traces, evals, models
- `demo/MANIFEST.json` — provenance: `{vlmDental: {commit, branch, dirty}, buildDate, toolVersions, counts, sha256 per asset, licences}`
- `public/demo-assets/images/*.jpg` — downscaled radiographs (`full_1536` q85 + `thumb_320`, EXIF stripped)
- `public/demo-assets/artifacts/*` — downscaled real tool renders (optimised PNG)

**Budgets (enforced by the build):**
- Assets ≤ 25 MB total
- Bundle JSON ≤ 15 MB
- One full image ≤ 500 KB

## Sanitization (allow-list reader)

Only known fields survive. Removed: absolute paths, usernames, hostnames,
provider request IDs, keys, headers, private HF repo names, raw provider
metadata. Canary test: a fake secret and a fake `C:\Users\...` path in a fixture
trace must not appear in any output; negative control disables the sanitizer and
shows the test fails. CI scans `demo/` and `public/demo-assets/` for key
patterns (`hf_`, `sk-`, `AIza`, `C:\Users\`, `/home/`).

## Licence guard

Every bundle item carries `dataset`, `license`, `source`. The build fails on any
item whose `dataset` is not `dentex`. CI test scans `demo/` and `public/` for
`tufts` markers in paths, ids, and JSON. `.gitignore` covers `data/` mirrors
and `reports/`.

## Seed (`scripts/demo-seed.ts`)

Idempotent upserts into a fixed-slug "demo" org (images, traces with turns,
tool calls and artifact references, eval runs and cases, model registry rows,
dataset rows) through the existing ingest repositories. Run twice: identical row
counts (test). A changed bundle updates rows, never duplicates. Refuses a
database not marked as a demo target unless `--force`.

## Static asset delivery

Read-only `STORAGE_PROVIDER=static` adapter mapping keys to `/demo-assets/...`;
writes throw a clear read-only error that the UI turns into a message.
Live-worker artifacts use the real R2 adapter (WP8).

## Round-trip proof

Import a real trace JSONL, store, export, deep-equal modulo documented derived
fields; one real trace per cohort plus trace 255.

## Acceptance

On a truly empty DB, `pnpm demo:build && pnpm demo:seed` gives a working app
(smoke, strict console, axe) with all real data visible; sizes under budget;
leak and licence tests with negative controls.