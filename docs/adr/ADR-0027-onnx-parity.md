# ADR-0027: ONNX parity thresholds and browser YOLO runtime

**Status:** proposed — nothing in this ADR is implemented. There is no export
script, no `.onnx` file, no `onnxruntime` dependency and no YOLO TypeScript in
this repository. The ladder therefore never offers the browser rung for
`yolo.prelabel`; it falls back to stored predictions, which is honest.
**Date:** 2026-11-07 (revised 2026-11-11 to remove claims that were never built)
**Context:** the intent is browser-side YOLO pre-labelling via `onnxruntime-web`
using the DENTEX-only grounding checkpoints. This ADR records the design and the
constraints. It stays `proposed` until an export and a parity run exist.

## What exists today

- The grounding checkpoint is real and DENTEX-only:
  `data/models/dentex_only_fold_0/weights/best.pt`, **52,090,194 bytes
  (49.7 MiB)**, and `data/models/dentex_grounding_tool_cv_best/cv_results.json`
  records five DENTEX-only folds with `mean_map50` **0.932** and `mean_map50_95`
  **0.536**.
- The worker path (`yolo.prelabel`) runs the same checkpoint through
  Ultralytics and is covered by `examples/python-worker/test_tools_goldens.py`.
- The browser rung for `yolo.prelabel` is gated on `browserSupported`, which no
  page sets, so the ladder reports worker / replay / unavailable only.

## What does not exist

No `tools/export_yolo_onnx.py`, no `public/models/yolo/*`, no
`src/shared/domain/yolo/`, no `onnxruntime-web` in `package.json`. An earlier
revision of this ADR listed "recorded" ONNX sizes of 24/12/6 MB and marked
itself accepted; both were wrong. The sizes were never measured, and a
YOLOv8m-class checkpoint of 49.7 MiB does not export to 24 MB as fp32 ONNX —
the expected fp32 size is roughly twice the checkpoint, around 100 MB. That
figure is an expectation, not a measurement, and this ADR does not treat it as
evidence.

## Export (not implemented)

`tools/export_yolo_onnx.py` would need `ultralytics`, `onnx` and `onnxsim` and
would produce, at `imgsz=640` (matching training) with opset 17:

| Variant | Opset | Simplify | Static shapes | Size |
|---------|-------|----------|---------------|------|
| fp32    | 17    | yes      | 640x640       | not measured; expected ≈ 100 MB |
| fp16    | 17    | yes      | 640x640       | not measured; expected ≈ 50 MB |
| int8 dyn| 17    | yes      | 640x640       | not measured; expected ≈ 25 MB |

The size column stays empty until someone exports the files and records
`Get-Item .Length` for each. The decision rule below depends on that number.

## Pre/post-processing parity (design)

- Letterbox to 640x640 (preserve aspect, pad with 114)
- Output decode: `cx, cy, w, h, conf, cls...` → xyxy in 640 space
- NMS: IoU threshold 0.45, conf threshold 0.25 (configurable)
- Rescale boxes back to original image pixels

Goldens would be Ultralytics inference on `val_18`, `val_32`, `val_44` (3
images) saved as JSON fixtures. Node `onnxruntime-node` and browser
`onnxruntime-web` must match within thresholds.

## Parity thresholds (to be measured, not assumed)

| Metric | fp32 target | fp16 target | int8 target | Notes |
|--------|-------------|-------------|-------------|-------|
| Per-box IoU vs Ultralytics | ≥ 0.95 | ≥ 0.93 | ≥ 0.90 | On the 3 golden images |
| Confidence diff (max per box) | ≤ 0.01 | ≤ 0.02 | ≤ 0.03 | |
| mAP50 drop vs Ultralytics | 0.0 | ≤ 0.01 | ≤ 0.02 | On the 3 golden images |
| Inference time (browser, WASM) | — | — | — | Must complete < 3 s on M1 / mid-range laptop |

**Decision rule:** choose the smallest variant that meets fp32 thresholds. If
the chosen file exceeds Vercel's static-file limit, host it on R2/Blob with long
cache headers and CSP `connect-src` for the model URL.

## Browser runtime constraints (design)

- `onnxruntime-web` pinned (>= 14 days at release)
- WASM backend, single-threaded (avoids cross-origin isolation requirement)
- Runs inside a Web Worker (off main thread)
- WASM files self-hosted under `/models/yolo/` — CSP allows no other hosts
- `wasm-unsafe-eval` added to CSP only if required (document why)
- Model downloads only after the user clicks "Run in my browser (about N MB)"
- Progress shown; cached in Cache Storage with hash check
- Every failure (no WASM, OOM, aborted download) has a user-facing message
- Results labelled: "In your browser: DENTEX-trained YOLOv8m, confidence ≥ x"

## Ladder integration (design)

The browser rung for `yolo.prelabel` becomes real and is advertised only when
the browser reports support (`ort.env.wasm.wasmPaths` resolvable, Web Worker
works, memory check passes). The editor's "Suggest boxes" uses it with the same
authoring rules as the worker path (model boxes authored by the viewer,
`model_id` recorded).

## Licensing

`LICENSES/YOLO-AGPL-3.0.md` with the Ultralytics AGPL-3.0 notice. Model card:
training data DENTEX only; metrics are the real values from `cv_results.json`;
"not for clinical use"; link to source. This is not legal advice.

## Tests (when built)

- Unit goldens: TS pre/post vs Ultralytics output on 3 images
- Node ORT vs Python Ultralytics parity (CI, fast)
- Playwright with a tiny fixture ONNX in CI (fast) + one opt-in spec with the real model
- Cache reuse on second run; aborted download shows the message
- Strict console; axe; `labels-budget` spec still passes

## Acceptance (unchanged, all unmet)

- Sizes and parity numbers measured and written into this ADR
- Parity report attached to the PR
- Editor can pre-label `val_18` in the browser with the worker down
