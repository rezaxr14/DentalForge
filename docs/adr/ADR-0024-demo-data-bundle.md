# ADR-0024: Demo data bundle — selection, build, seed, and provenance

**Status:** accepted
**Date:** 2026-11-07
**Context:** The public demo bundle is sourced only from DENTEX data in
`../vlm-dental`. The bundle is the single source of truth for the deployed demo
and for local fixture fallback.

## Selection rules (fixed in `scripts/demo_build.py`)

The selection is deterministic and lives in the builder as three id lists
(`LABEL_IDS`, `ARTIFACT_IDS`, `VAL_NAMES`); there is no editable
`demo/selection.json`. What the builder actually produced is recorded in
`demo/MANIFEST.json`: **22 images, 38 traces, 8 eval runs, 395 eval cases,
9 model rows**.

1. Images:
   - The 5 existing label fixtures (`1..5` in `public/labels/`)
   - Validation images with traces: `val_18`, `val_32`, `val_44`
   - Trace-255 image (`train_477.png`) and a spread of healthy + failing cases
2. Traces on those images:
   - Always include trace 255 (with-tools, 23 turns, 66 tool calls, 15 artifact links)
   - With-tools / no-tools pairs where they exist
   - At least one failing or malformed trace so the UI shows honest failure
3. All 8 tracked zero-shot evaluation files + the 9 model rows the bundle carries
4. The YOLO grounding tool's registry row with real `cv_results.json` metrics
5. The VLM-DENTAL commit, branch and dirty flag recorded in `demo/MANIFEST.json`

`pnpm demo:build -- --propose` prints the selection and exits without writing;
`pnpm demo:build` writes the bundle. A dirty VLM-DENTAL checkout is recorded,
and `--allow-dirty` makes that explicit.

## Build (`scripts/demo_build.py`)

`pnpm demo:build` runs the Python CLI directly (no Node orchestrator). It reads
the read-only VLM-DENTAL checkout, renders artifacts with the same code the
worker uses, and writes:

- `demo/bundle.json` — sanitized images, traces, evals, models
- `demo/MANIFEST.json` — provenance: `{vlmDental: {commit, branch, dirty}, buildDate, toolVersions, counts, bundleBytes, assetBytesTotal, sha256 + bytes per asset, licences}`
- `public/demo-assets/images/*.jpg` — downscaled radiographs (full + thumb, EXIF stripped)
- `public/demo-assets/artifacts/*.jpg` — downscaled real tool renders

The build fails on a budget violation, a forbidden path or secret pattern, or
an item that is not `dentex`. `tests/python/test_demo_build.py` exercises each
of those guards.

**Budgets (enforced by the build):**
- Assets ≤ 25 MB total
- Bundle JSON ≤ 15 MB
- One full image ≤ 500 KB

## Sanitization (allow-list reader)

Only known fields survive. Removed: absolute paths, usernames, hostnames,
provider request IDs, keys, headers, private HF repo names, raw provider
metadata. Canary test: a fake secret and a fake `C:\Users\...` path are fed to
the scanner and must be reported, and the committed `demo/bundle.json` and asset
paths must scan clean. CI runs the same scan over `demo/` and
`public/demo-assets/` for key patterns (`hf_`, `sk-`, `AIza`, `C:\Users\`,
`/home/`) plus an EXIF check on every image.

## Licence guard

Every bundle item carries `dataset`, `license`, `source`. The build fails on any
item whose `dataset` is not `dentex`. CI test scans `demo/` and `public/` for
`tufts` markers in paths, ids, and JSON. `.gitignore` covers `data/` mirrors
and `reports/`.

## Seed (`scripts/demo-seed.ts`)

Idempotent upserts into a fixed-slug "demo" org (images, traces with turns,
tool calls and artifact references, eval runs and cases, model registry rows,
dataset rows) through the existing ingest repositories. `--reset` deletes the
demo org first; `--dry-run` prints the plan and writes nothing. Two runs without
`--reset` give identical row counts (`tests/demo-seed-idempotent.test.ts`). A
changed bundle updates rows, never duplicates. The seed does not verify that the
target database is a demo instance — point `DATABASE_URL` at the wrong database
and it will write there.

## Static asset delivery

Read-only `STORAGE_PROVIDER=static` adapter mapping keys to `/demo-assets/...`;
writes throw a clear read-only error that the UI turns into a message.
The R2 adapter is **not implemented**: it throws. Live-worker artifact upload
therefore works only with the local filesystem adapter, which is ephemeral on
Vercel. Production upload is expected to fail visibly rather than pretend to
persist.

## Round-trip proof

Import a real trace JSONL, store, export, deep-equal modulo documented derived
fields; one real trace per cohort plus trace 255.

## Acceptance

On a truly empty DB, `pnpm demo:build && pnpm demo:seed` gives a working app
(smoke, strict console, axe) with all real data visible; sizes under budget;
leak and licence tests with negative controls.