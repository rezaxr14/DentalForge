# ADR-0026: Sanitiser, licence guard, and secret/path scan

**Status:** accepted
**Date:** 2026-11-07
**Context:** The demo bundle must contain only DENTEX-derived data,
sanitized of secrets, absolute paths, and provider metadata. The build must fail
on any Tufts leakage.

## Sanitiser (`scripts/demo_build.py`)

Allow-list per top-level object type:

- **Image**: `key`, `datasetId`, `sourceFile`, `split`, `full`, `thumb`, `width`, `height`, `assetWidth`, `assetHeight`, `sha256`, `license`
- **Trace**: `image_id`, `dataset`, `ground_truth`, `turns`, `tool_calls`, `final_answer`, `format_ok`, `verifier_reason`, `source_file`, `mode`, `cohort`
- **Turn**: `turn`, `raw_output`, `parsed`, `status`, `tool_calls_this_turn`
- **ToolCall**: `tool_name`, `tool_args`, `tool_ok`, `tool_error`, `true_bbox`, `perturb_tier`, `artifact_key`
- **EvalRun**: `runKey`, `sourceFile`, `dataset`, `split`, `provider`, `model`, `n`, `summary`, `cases`
- **EvalCase**: `image_id`, `prediction`, `ground_truth`, `scores`, `format_ok`, `timestamp`
- **Model**: `name`, `stage`, `backend`, `notes`, `metrics`, `license`

Any extra key is dropped. Nested objects are sanitized recursively with their
own allow-lists.

### Canary test (required in CI)

A fixture trace in `fixtures/traces/canary_secret.json` contains:

```json
{
  "image_id": 999,
  "dataset": "dentex",
  "ground_truth": [],
  "turns": [],
  "tool_calls": 0,
  "final_answer": [],
  "format_ok": true,
  "fake_secret": "hf_abcdefghijklmnopqrstuvwxyz123456",
  "fake_path": "C:\\Users\\owner\\secret\\model.bin"
}
```

The build must produce no `fake_secret` or `fake_path` in any output.
Negative control: run with `--no-sanitize` and assert the test fails (the
strings appear in `demo/bundle.json`).

## Licence guard

Every bundle item must carry `dataset` and `license`. The build fails if any
item has `dataset !== "dentex"`. This is a hard gate — no Tufts data can enter
the demo bundle.

### CI scan

```bash
# Fail on any tufts marker in demo/ or public/demo-assets/
rg -i "tufts" demo/ public/demo-assets/ && exit 1 || exit 0
# Fail on any secret/path pattern
rg -i "(hf_|sk-|AIza|C:\\\\Users\\\\|/home/)" demo/ public/demo-assets/ && exit 1 || exit 0
```

## Provenance (`demo/MANIFEST.json`)

```json
{
  "vlmDental": { "commit": "...", "branch": "main", "dirty": false },
  "buildDate": "2026-11-07T07:35:21.973580+00:00",
  "toolVersions": { "python": "3.11.9", "ultralytics": "8.2.0", "onnxruntime": "1.18.0" },
  "counts": { "images": 22, "traces": 38, "evalRuns": 8, "evalCases": 395, "artifacts": 40, "artifactLinks": 15 },
  "licences": { "dentex": "CC-BY-NC-SA-4.0", "ultralytics": "AGPL-3.0" },
  "bundleBytes": 1976447,
  "assets": [ { "key": "...", "sha256": "...", "bytes": 12345 } ]
}
```

The `/about-data` page reads this manifest and displays the DENTEX citation
(CC BY-NC-SA 4.0), the YOLO AGPL notice, "Research prototype, not for clinical
use", and which items are real recorded runs versus test-backend runs.

## Acceptance

- `pnpm demo:build` on a clean repo produces `demo/bundle.json` and
  `demo/MANIFEST.json` with all counts > 0, sizes under budget
- Canary test passes (no secrets/paths in output), negative control fails
- Licence guard test passes (no `tufts` in demo/ or public/)
- Secret/path CI scan passes
- `.gitignore` covers `data/` and `reports/`